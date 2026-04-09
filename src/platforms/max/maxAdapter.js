'use strict';

const axios = require('axios');
const FormData = require('form-data');

const { normalizeText } = require('../../utils/content');
const { getAttachmentUrl, rewriteToInternalChatwootUrl } = require('../../utils/attachments');

class MaxAdapter {
  constructor({ maxClient, chatwootClient, state }) {
    this.max = maxClient;
    this.cw = chatwootClient;
    this.state = state;
  }

  name() { return 'max'; }

  parseWebhook(body) {
    if (!body || typeof body !== 'object') return null;
    const updateType = body.update_type;
    if (!updateType) return null;
    return { type: updateType, payload: body };
  }

  async handleUpdate(type, payload) {
    switch (type) {
      case 'message_created':
      case 'message_callback':
        await this.handleInbound(payload);
        return;
      case 'message_edited':
        await this._handleMessageEdited(payload);
        return;
      case 'message_removed':
        await this._handleMessageRemoved(payload);
        return;
      case 'chat_title_changed':
        await this._handleChatTitleChanged(payload);
        return;
      default:
        return;
    }
  }

  async handleInbound(update) {
    const msg = update?.message;
    if (!msg || typeof msg !== 'object') return;
    if (msg?.sender?.is_bot) return;

    const sender = msg.sender;
    const chat = msg?.recipient;
    const userId = sender?.user_id || sender?.id || null;
    const chatId = chat?.chat_id || null;
    const chatType = chat?.chat_type || 'dialog';
    const isGroup = chatType !== 'dialog';
    if (!userId && !chatId) return;

    const userName = sender?.name || `Пользователь ${userId || chatId}`;
    let text = normalizeText(msg?.body?.text || '');
    const mid = msg?.body?.mid;
    const attachments = Array.isArray(msg?.body?.attachments) ? msg.body.attachments : [];
    if (!text && attachments.length === 0) return;

    if (update?.update_type === 'message_callback') {
      const cb = normalizeText(update?.callback?.payload || '') || normalizeText(update?.callback?.data || '') || normalizeText(update?.callback?.text || '');
      if (cb) text = text ? `${text}\n${cb}` : cb;
    }

    let chatKey;
    let contactIdentifier;
    let contactName;
    if (isGroup) {
      const title = await this._getChatTitle(chatId);
      chatKey = `chat_${chatId}`;
      contactIdentifier = `max_chat_${chatId}`;
      contactName = title;
      this.state.chatNameMap.set(chatKey, title);
    } else {
      const privateKey = userId || chatId;
      chatKey = `user_${privateKey}`;
      contactIdentifier = `max_${privateKey}`;
      contactName = userName;
      this.state.chatNameMap.set(chatKey, contactName);
    }

    let convId;
    try {
      const contactId = await this._findOrCreateContact(contactIdentifier, contactName);
      convId = await this._findOrCreateConversation(chatKey, contactId);
    } catch (err) {
      console.error('[MAX->CW ERROR] cannot create/find conversation', err.response?.status, err.response?.data || err.message);
      return;
    }

    this.state.reverseMap.map.set(Number(convId), { chatKey, chatId: chatId || null, userId, isGroup });
    this.state.reverseMap.save();
    await this._initBaselineForConversation(convId);
    if (mid) this.state.lastMidMap.set(String(convId), mid);

    const prefix = isGroup ? `${userName}: ` : '';
    if (attachments.length > 0) {
      for (const att of attachments) {
        const url = getAttachmentUrl(att);
        if (!url) continue;
        const ok = await this._sendMediaToChatwoot(convId, url, att.type, prefix + (text || ''));
        if (!ok) {
          try {
            await this.cw.createMessage(convId, { content: `${prefix}${text ? text + '\n' : ''}${url}`, message_type: 'incoming', private: false });
          } catch (_) {}
        }
      }
      return;
    }

    if (text) {
      try {
        const created = await this.cw.createMessage(convId, { content: prefix + text, message_type: 'incoming', private: false });
        if (mid && created?.id) {
          this.state.maxMidToCwMessageMap.map.set(String(mid), { convId: Number(convId), messageId: Number(created.id) });
          this.state.maxMidToCwMessageMap.save();
        }
      } catch (err) {
        console.error('[MAX->CW ERROR] createMessage failed', err.response?.status, err.response?.data || err.message);
      }
    }
  }

  async send(target, message) {
    const text = normalizeText(message?.text || '');
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const replyMid = message?.replyTo?.mid || null;
    const chatId = target?.chatId || null;
    const userId = target?.userId || null;

    if (attachments.length === 0) {
      if (!text) return;
      await this.max.sendMessage({ chatId, userId, text, replyMid });
      return;
    }

    console.log('[CW->MAX] sending attachments', { chatId, userId, count: attachments.length, hasText: !!text });
    let hadErrors = false;
    let first = true;
    for (const att of attachments) {
      try {
        await this._sendAttachmentToMax({ target: { chatId, userId }, att, caption: first ? text : '', replyMid: first ? replyMid : null });
      } catch (err) {
        console.error('[CW->MAX MEDIA ERROR]', err.response?.status, err.response?.data || err.message);
        // Do not send attachment URL fallback to MAX:
        // operators expect media, not an internal Chatwoot storage link.
        hadErrors = true;
      }
      first = false;
    }
    if (hadErrors) {
      throw new Error('One or more attachments failed to send to MAX');
    }
  }

  async _getChatTitle(chatId) {
    const k = String(chatId);
    if (this.state.chatTitleCache.has(k)) return this.state.chatTitleCache.get(k);
    try {
      const res = await this.max.getChat(chatId);
      const title = res?.title || `Группа ${chatId}`;
      this.state.chatTitleCache.set(k, title);
      return title;
    } catch (_) {
      return `Группа ${chatId}`;
    }
  }

  async _findOrCreateContact(identifier, name) {
    try {
      const found = await this.cw.searchContacts(identifier);
      const exact = found.find(c => c.identifier === identifier);
      if (exact) return exact.id;
    } catch (_) {}
    const created = await this.cw.createContact({ name, identifier });
    return created.id;
  }

  async _findOrCreateConversation(chatKey, contactId) {
    if (this.state.conversationMap.has(chatKey)) return this.state.conversationMap.get(chatKey);
    const existing = await this.cw.listContactConversations(contactId);
    const open = existing.find(c => c.inbox_id === this.cw.inboxId && c.status !== 'resolved');
    if (open) {
      this.state.conversationMap.set(chatKey, open.id);
      return open.id;
    }
    const created = await this.cw.createConversation({ contactId });
    const convId = created.id;
    this.state.conversationMap.set(chatKey, convId);
    const name = this.state.chatNameMap.get(chatKey);
    if (name) {
      try { await this.cw.updateConversation(convId, { name }); } catch (_) {}
    }
    return convId;
  }

  async _initBaselineForConversation(convId) {
    if (this.state.chatwootBaselineMap.has(String(convId))) return;
    try {
      const messages = await this.cw.listConversationMessages(convId);
      const maxId = messages.reduce((acc, m) => Math.max(acc, Number(m?.id || 0)), 0);
      this.state.chatwootBaselineMap.set(String(convId), maxId);
    } catch (e) {
      console.error('[CW BASELINE NEW CONV ERROR]', e.response?.status, e.response?.data || e.message);
    }
  }

  async _handleMessageEdited(update) {
    const msg = update?.message;
    const mid = msg?.body?.mid || update?.mid || null;
    const newText = normalizeText(msg?.body?.text || update?.text || '');
    if (!mid) return;
    const mapped = this.state.maxMidToCwMessageMap.map.get(String(mid));
    if (!mapped?.convId || !mapped?.messageId) return;
    try {
      await this.cw.updateMessage(mapped.convId, mapped.messageId, { content: newText || '' });
    } catch (err) {
      if (err?.response?.status === 404) {
        try {
          await this.cw.createMessage(mapped.convId, {
            content: newText ? `[сообщение отредактировано]\n${newText}` : '[сообщение отредактировано]',
            message_type: 'incoming',
            private: false
          });
          return;
        } catch (_) {}
      }
      console.error('[MAX->CW ERROR] updateMessage failed', err.response?.status, err.response?.data || err.message);
    }
  }

  async _handleMessageRemoved(update) {
    const msg = update?.message;
    const mid = msg?.body?.mid || update?.mid || null;
    if (!mid) return;
    const mapped = this.state.maxMidToCwMessageMap.map.get(String(mid));
    if (!mapped?.convId || !mapped?.messageId) return;
    try {
      await this.cw.deleteMessage(mapped.convId, mapped.messageId);
      this.state.maxMidToCwMessageMap.map.delete(String(mid));
      this.state.maxMidToCwMessageMap.save();
    } catch (err) {
      console.error('[MAX->CW ERROR] deleteMessage failed', err.response?.status, err.response?.data || err.message);
    }
  }

  async _handleChatTitleChanged(update) {
    const chatId = update?.chat_id || update?.chat?.chat_id || update?.message?.recipient?.chat_id || null;
    const title = normalizeText(update?.title || '') || normalizeText(update?.chat_title || '') || normalizeText(update?.chat?.title || '');
    if (!chatId || !title) return;
    this.state.chatTitleCache.set(String(chatId), title);
    const chatKey = `chat_${chatId}`;
    this.state.chatNameMap.set(chatKey, title);
    const convId = this.state.conversationMap.get(chatKey);
    if (convId) {
      try { await this.cw.updateConversation(convId, { name: title }); } catch (_) {}
      return;
    }
    for (const [convIdKey, info] of this.state.reverseMap.map.entries()) {
      if (info?.isGroup && String(info?.chatId) === String(chatId)) {
        try { await this.cw.updateConversation(convIdKey, { name: title }); } catch (_) {}
      }
    }
  }

  async _sendMediaToChatwoot(convId, fileUrl, type, caption) {
    try {
      const primaryUrl = String(fileUrl);
      const rewrittenUrl = rewriteToInternalChatwootUrl(primaryUrl);
      let fileRes;
      try {
        fileRes = await axios.get(primaryUrl, { responseType: 'arraybuffer', timeout: 30000 });
      } catch (e) {
        if (rewrittenUrl && rewrittenUrl !== primaryUrl) {
          fileRes = await axios.get(rewrittenUrl, { responseType: 'arraybuffer', timeout: 30000 });
        } else {
          throw e;
        }
      }
      const form = new FormData();
      const filename = this._extractFilenameFromUrl(primaryUrl, type);
      const contentType = fileRes.headers['content-type'] || this._defaultContentType(this._inferUploadType({ type }, null));
      form.append('content', caption || '');
      form.append('message_type', 'incoming');
      form.append('private', 'false');
      form.append('attachments[]', fileRes.data, {
        filename,
        contentType
      });
      await axios.post(`${this.cw.baseUrl}/api/v1/accounts/${this.cw.accountId}/conversations/${convId}/messages`, form, {
        headers: { ...form.getHeaders(), api_access_token: process.env.CHATWOOT_TOKEN },
        timeout: 30000
      });
      return true;
    } catch (err) {
      console.error('[MEDIA->CW ERROR]', {
        convId,
        fileUrl: String(fileUrl),
        rewrittenUrl: rewriteToInternalChatwootUrl(String(fileUrl)),
        status: err.response?.status,
        data: err.response?.data || err.message
      });
      return false;
    }
  }

  async _sendAttachmentToMax({ target, att, caption, replyMid }) {
    const originalUrl = getAttachmentUrl(att);
    if (!originalUrl) return;
    const primaryUrl = String(originalUrl);
    const rewrittenUrl = rewriteToInternalChatwootUrl(primaryUrl);
    let fileRes;
    try {
      fileRes = await axios.get(primaryUrl, { responseType: 'arraybuffer', timeout: 30000 });
    } catch (e) {
      if (rewrittenUrl && rewrittenUrl !== primaryUrl) {
        fileRes = await axios.get(rewrittenUrl, { responseType: 'arraybuffer', timeout: 30000 });
      } else {
        throw e;
      }
    }

    const uploadType = this._inferUploadType(att, fileRes.headers?.['content-type']);
    const filename = this._extractFilename(att, uploadType);
    const contentType = fileRes.headers?.['content-type'] || this._defaultContentType(uploadType);
    console.log('[CW->MAX] upload start', { uploadType, filename, contentType, bytes: Buffer.byteLength(fileRes.data || '') });
    const uploaded = await this.max.uploadBinary({
      uploadType,
      buffer: Buffer.from(fileRes.data),
      filename,
      contentType
    });
    console.log('[CW->MAX] upload done', { uploadType, token: uploaded?.token ? 'yes' : 'no' });
    await this.max.sendMessageWithAttachments({
      chatId: target?.chatId || null,
      userId: target?.userId || null,
      text: caption || '',
      replyMid,
      attachments: [{ type: uploadType, payload: uploaded.payload }]
    });
    console.log('[CW->MAX] message with attachment sent', { uploadType });
  }

  _inferUploadType(att, contentType) {
    const raw = String(att?.file_type || att?.type || att?.content_type || contentType || '').toLowerCase();
    if (raw.includes('image')) return 'image';
    if (raw.includes('video')) return 'video';
    if (raw.includes('audio')) return 'audio';
    return 'file';
  }

  _extractFilename(att, uploadType) {
    return att?.file_name || att?.filename || att?.name || `attachment.${uploadType === 'image' ? 'jpg' : uploadType === 'video' ? 'mp4' : uploadType === 'audio' ? 'mp3' : 'bin'}`;
  }

  _defaultContentType(uploadType) {
    if (uploadType === 'image') return 'image/jpeg';
    if (uploadType === 'video') return 'video/mp4';
    if (uploadType === 'audio') return 'audio/mpeg';
    return 'application/octet-stream';
  }

  _extractFilenameFromUrl(url, fallbackType) {
    const extByType = {
      image: 'jpg',
      video: 'mp4',
      audio: 'mp3',
      file: 'bin'
    };
    try {
      const p = new URL(String(url)).pathname || '';
      const raw = decodeURIComponent(p.split('/').pop() || '').trim();
      if (raw && raw.includes('.')) return raw;
    } catch (_) {}
    const t = this._inferUploadType({ type: fallbackType }, null);
    return `attachment.${extByType[t] || 'bin'}`;
  }
}

module.exports = { MaxAdapter };
