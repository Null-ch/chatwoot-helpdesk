 'use strict';
 
 const axios = require('axios');
 
 class ChatwootClient {
   constructor({ baseUrl, accountId, accessToken, inboxId }) {
     this.baseUrl = baseUrl;
     this.accountId = accountId;
     this.inboxId = inboxId;
    this._cachedInboxIdentifier = null;
 
     this.http = axios.create({
       baseURL: `${baseUrl}/api/v1/accounts/${accountId}`,
      maxRedirects: 0,
       headers: {
         api_access_token: accessToken,
         'Content-Type': 'application/json'
       }
     });
   }
 
   async searchContacts(identifier) {
     const res = await this.http.get('/contacts/search', {
       params: { q: identifier, include_contacts: true }
     });
     return Array.isArray(res.data?.payload) ? res.data.payload : [];
   }
 
   async createContact({ name, identifier }) {
     const res = await this.http.post('/contacts', { name, identifier });
     const id = res.data?.payload?.contact?.id || res.data?.contact?.id || res.data?.id;
     return { id };
   }
 
   async listContactConversations(contactId) {
     const res = await this.http.get(`/contacts/${contactId}/conversations`);
     return Array.isArray(res.data?.payload) ? res.data.payload : [];
   }
 
   async createConversation({ contactId }) {
     const res = await this.http.post('/conversations', {
       inbox_id: this.inboxId,
       contact_id: contactId
     });
     return { id: res.data?.id };
   }
 
   async updateConversation(convId, patch) {
     await this.http.patch(`/conversations/${convId}`, patch);
   }
 
  async createMessage(convId, { content, message_type, private: isPrivate, content_attributes }) {
   const payload = {
       content,
       message_type,
       private: !!isPrivate
    };
   if (content_attributes && typeof content_attributes === 'object') {
     payload.content_attributes = content_attributes;
   }
   const res = await this.http.post(`/conversations/${convId}/messages`, payload);
    return { id: res.data?.id };
   }
 
  async updateMessage(convId, messageId, patch) {
    // Chatwoot Application API doesn't support editing messages.
    // Use Public API for message update.
    const inboxIdentifier = await this._getInboxIdentifier();
    const contactIdentifier = await this._getContactIdentifierForConversation(convId);

    const res = await axios.patch(
      `${this.baseUrl}/public/api/v1/inboxes/${encodeURIComponent(inboxIdentifier)}/contacts/${encodeURIComponent(
        contactIdentifier
      )}/conversations/${convId}/messages/${messageId}`,
      {
        submitted_values: {
          // Public API expects submitted_values payload
          content: patch?.content ?? ''
        }
      },
      { headers: { 'Content-Type': 'application/json' }, maxRedirects: 0 }
    );
    return res.data;
  }

  async deleteMessage(convId, messageId) {
    await this.http.delete(`/conversations/${convId}/messages/${messageId}`);
  }

  async _getInboxIdentifier() {
    if (this._cachedInboxIdentifier) return this._cachedInboxIdentifier;
    const res = await this.http.get(`/inboxes/${this.inboxId}`);
    const ident = res.data?.inbox_identifier;
    if (!ident) throw new Error('Chatwoot inbox_identifier missing for inboxId=' + this.inboxId);
    this._cachedInboxIdentifier = ident;
    return ident;
  }

  async _getContactIdentifierForConversation(convId) {
    const conv = await this.getConversation(convId);
    const ident = conv?.meta?.sender?.identifier;
    if (!ident) throw new Error('Chatwoot contact identifier missing for convId=' + convId);
    return String(ident);
  }

   async getConversation(convId) {
     const res = await this.http.get(`/conversations/${convId}`);
     return res.data;
   }
 
   async listConversationMessages(convId) {
     const res = await this.http.get(`/conversations/${convId}/messages`);
     return Array.isArray(res.data?.payload) ? res.data.payload : [];
   }
 }
 
 module.exports = {
   ChatwootClient
 };
