 'use strict';
 
 const { normalizeText } = require('../utils/content');
const { resolveDirection, resolvePlatform } = require('./platformResolver');
 
 class BridgeCore {
  constructor({ helpdesk, platform, state, metadataStore }) {
     this.helpdesk = helpdesk;
     this.platform = platform;
     this.state = state;
    this.metadataStore = metadataStore || null;
   }
 
   async handlePlatformWebhook(body) {
     const evt = this.platform.parseWebhook(body);
     if (!evt) return false;
 
    // Delegate to adapter: it knows how to interpret platform-specific update types.
    if (typeof this.platform.handleUpdate === 'function') {
      await this.platform.handleUpdate(evt.type, evt.payload);
      return true;
    }

    // Backward-compat: old adapters only supported message_created inbound.
    if (evt.type === 'message_created') await this.platform.handleInbound(evt.payload);
     return true;
   }
 
   async handleChatwootWebhook(body) {
    const { event, message_type, content, conversation, content_attributes, attachments: webhookAttachments, private: isPrivate } = body || {};
    if (event !== 'message_created') return;
 
     const convId = conversation?.id;
     const msgId = body?.id;
     if (!convId || msgId === undefined || msgId === null) return;
    const direction = resolveDirection(message_type);
    const platform = resolvePlatform({ conversation, fallback: this.platform?.name?.() || 'web' });

    await this._annotateMessage(msgId, { direction, platform });
    if (direction !== 'outgoing') return;
    if (isPrivate === true) return;
 
     let info = this.state.reverseMap.map.get(Number(convId));
 
     if (!info) {
       try {
         const r = await this.helpdesk.getConversation(convId);
         const ident = r?.meta?.sender?.identifier;
 
         if (!ident) {
           console.warn('[CW WEBHOOK] no identifier for conv=' + convId);
           return;
         }
 
         const isGroup = ident.startsWith('max_chat_');
         const rawId = String(ident).replace('max_chat_', '').replace('max_', '');
 
         info = {
           chatKey: ident,
           chatId: isGroup ? rawId : null,
           userId: isGroup ? null : rawId,
           isGroup
         };
 
         this.state.reverseMap.map.set(Number(convId), info);
         this.state.reverseMap.save();
 
         await this._initBaselineForConversation(convId);
       } catch (e) {
         console.warn('[CW WEBHOOK] restore error:', e.message);
         return;
       }
     }
 
     const isReply = !!(content_attributes?.in_reply_to);
     const replyMid = isReply ? this.state.lastMidMap.get(String(convId)) : null;
 
     try {
       const messages = await this.helpdesk.listConversationMessages(convId);
       const thisMsg = messages.find(m => String(m.id) === String(msgId));
 
       let attachments = thisMsg?.attachments || [];
       if ((!attachments || attachments.length === 0) && webhookAttachments) {
         attachments = webhookAttachments;
       }
 
       const normalizedContent = normalizeText(content);
       const state = this.state.processed.get(msgId);
 
      if (normalizedContent && !state.textSent && attachments.length === 0) {
        await this.platform.send(info, {
          text: normalizedContent,
          replyTo: replyMid ? { mid: replyMid } : null,
          sourceMessageId: msgId,
          sourceConvId: convId
        });
         this.state.processed.mark(msgId, { textSent: true });
       }
 
      if (attachments.length > 0 && !this.state.processed.get(msgId).attachmentsSent) {
        console.log('[CW OUT] attachments via webhook', { convId, msgId, count: attachments.length, hasText: !!normalizedContent });
        await this.platform.send(info, {
          text: normalizedContent || '',
          attachments,
          replyTo: replyMid ? { mid: replyMid } : null,
          sourceMessageId: msgId,
          sourceConvId: convId
        });
        this.state.processed.mark(msgId, { attachmentsSent: true, textSent: true });
       } else if (attachments.length === 0) {
         this.state.processed.mark(msgId, { attachmentsSent: true });
       }
 
       if (!normalizedContent) {
         this.state.processed.mark(msgId, { textSent: true });
       }
     } catch (err) {
       console.error('[CW WEBHOOK ERROR]', err.response?.status, err.response?.data || err.message);
     }
   }
 
   async pollChatwootOutgoing() {
     try {
       this.state.processed.prune();
 
       for (const [convId, info] of this.state.reverseMap.map.entries()) {
         try {
           const messages = await this.helpdesk.listConversationMessages(convId);
           messages.sort((a, b) => Number(a?.id || 0) - Number(b?.id || 0));
 
           const baseline = this.state.chatwootBaselineMap.get(String(convId)) || 0;
 
           for (const message of messages) {
             const msgId = Number(message?.id || 0);
             if (msgId <= baseline) continue;
 
             await this._processChatwootMessage(convId, info, message);
 
             const currentBaseline = this.state.chatwootBaselineMap.get(String(convId)) || 0;
             if (msgId > currentBaseline) {
               this.state.chatwootBaselineMap.set(String(convId), msgId);
             }
           }
         } catch (err) {
           console.error('[CW POLL conversation error]', convId, err.response?.status, err.response?.data || err.message);
         }
       }
     } catch (err) {
       console.error('[CW POLL error]', err.response?.status, err.response?.data || err.message);
     }
   }
 
   async _initBaselineForConversation(convId) {
     if (this.state.chatwootBaselineMap.has(String(convId))) return;
     const messages = await this.helpdesk.listConversationMessages(convId);
     const maxId = messages.reduce((acc, m) => Math.max(acc, Number(m?.id || 0)), 0);
     this.state.chatwootBaselineMap.set(String(convId), maxId);
     console.log('[CW BASELINE NEW CONV]', { convId, maxId });
   }
 
   async _processChatwootMessage(convId, info, message) {
     const msgId = message?.id;
     if (msgId === undefined || msgId === null) return;
 
     const text = normalizeText(message?.content);
     const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
     const hasText = !!text;
     const hasAttachments = attachments.length > 0;
 
    if (!hasText && !hasAttachments) return;

    const direction = resolveDirection(message?.message_type);
    const platform = resolvePlatform({
      conversation: { meta: { sender: { identifier: info?.chatKey } } },
      fallback: this.platform?.name?.() || 'web'
    });
    await this._annotateMessage(msgId, { direction, platform });
    if (direction === 'incoming') return;
    if (message?.private === true) return;
 
     const state = this.state.processed.get(msgId);
     const isReply = !!(message?.content_attributes?.in_reply_to);
     const replyMid = isReply ? this.state.lastMidMap.get(String(convId)) : null;
 
    if (hasText && !state.textSent && !hasAttachments) {
      await this.platform.send(info, {
        text,
        replyTo: replyMid ? { mid: replyMid } : null,
        sourceMessageId: msgId,
        sourceConvId: convId
      });
       this.state.processed.mark(msgId, { textSent: true });
       console.log('[CW POLL] text sent', { convId, msgId });
     }
 
    if (hasAttachments && !this.state.processed.get(msgId).attachmentsSent) {
      console.log('[CW OUT] attachments via poll', { convId, msgId, count: attachments.length, hasText });
      await this.platform.send(info, {
        text: text || '',
        attachments,
        replyTo: replyMid ? { mid: replyMid } : null,
        sourceMessageId: msgId,
        sourceConvId: convId
      });
      this.state.processed.mark(msgId, { attachmentsSent: true, textSent: true });
    } else if (!hasAttachments) {
      this.state.processed.mark(msgId, { attachmentsSent: true });
    }
  }

  async _annotateMessage(messageId, payload) {
    if (!this.metadataStore) return;
    try {
      await this.metadataStore.annotateMessage(messageId, payload);
    } catch (err) {
      console.error('[MESSAGES META ERROR]', err.message);
    }
  }
 }
 
 module.exports = {
   BridgeCore
 };
