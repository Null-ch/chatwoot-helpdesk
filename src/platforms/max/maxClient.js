 'use strict';
 
 const axios = require('axios');
const FormData = require('form-data');
 
 class MaxClient {
   constructor({ baseUrl, token }) {
     this.http = axios.create({
       baseURL: baseUrl,
       headers: { Authorization: token }
     });
   }
 
   async pollUpdates({ marker }) {
    const params = {
      timeout: 30,
      types: 'message_created,message_callback,message_edited,message_removed,chat_title_changed'
    };
     if (marker) params.marker = marker;
     const res = await this.http.get('/updates', { params, timeout: 35000 });
     return res.data;
   }
 
   async sendMessage({ chatId, userId, text, replyMid }) {
    return this.sendMessageWithAttachments({ chatId, userId, text, replyMid, attachments: null });
  }

  async sendMessageWithAttachments({ chatId, userId, text, replyMid, attachments }) {
    const body = { text: text || '' };
    if (replyMid) body.link = { type: 'reply', mid: replyMid };
    if (Array.isArray(attachments) && attachments.length > 0) body.attachments = attachments;

    const params = chatId ? { chat_id: chatId } : { user_id: userId };
    await this._postMessageWithRetry(body, params);
  }

  async uploadBinary({ uploadType, buffer, filename, contentType }) {
    const uploadRes = await this.http.post('/uploads', null, {
      params: { type: uploadType },
      timeout: 30000
    });
    const uploadUrl = uploadRes.data?.url;
    if (!uploadUrl) {
      throw new Error('MAX /uploads did not return url');
    }

    const form = new FormData();
    form.append('data', buffer, {
      filename: filename || 'file',
      contentType: contentType || 'application/octet-stream'
    });

    const sent = await axios.post(uploadUrl, form, {
      headers: form.getHeaders(),
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const rawPayload =
      (sent.data && typeof sent.data === 'object' ? sent.data : null) ||
      (uploadRes.data && typeof uploadRes.data === 'object' ? uploadRes.data : null);

    const token = extractToken(rawPayload);
    if (!token) {
      throw new Error('MAX upload did not return valid payload');
    }

    // MAX messages endpoint accepts attachment payload with token.
    return {
      token,
      payload: { token },
      rawPayload
    };
   }
 
   async getChat(chatId) {
     const res = await this.http.get(`/chats/${chatId}`);
     return res.data;
   }

  async _postMessageWithRetry(body, params) {
    const delays = [0, 500, 1000, 2000];
    let lastErr = null;

    for (const delay of delays) {
      if (delay > 0) await sleep(delay);
      try {
        await this.http.post('/messages', body, { params, timeout: 30000 });
        return;
      } catch (err) {
        lastErr = err;
        const code = err?.response?.data?.code;
        if (code !== 'attachment.not.ready') {
          throw err;
        }
      }
    }

    throw lastErr || new Error('MAX message send failed');
  }
 }

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractToken(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (typeof obj.token === 'string' && obj.token) return obj.token;
  for (const value of Object.values(obj)) {
    if (!value || typeof value !== 'object') continue;
    const nested = extractToken(value);
    if (nested) return nested;
  }
  return null;
}
 
 module.exports = {
   MaxClient
 };
