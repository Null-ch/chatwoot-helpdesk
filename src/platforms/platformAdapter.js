 'use strict';
 
 /**
  * PlatformAdapter is an interface-like contract for chat platforms (MAX/Telegram/WhatsApp/VK).
  * BridgeCore depends on this abstraction (DIP).
  *
  * Methods are documented, implementations are plain JS classes.
  */
 class PlatformAdapter {
   /** @returns {string} */
   name() { throw new Error('Not implemented'); }
 
   /**
    * Convert webhook body to normalized inbound event.
    * @param {object} body
   * @returns {{ type: string, payload: any } | null}
    */
   parseWebhook(body) { throw new Error('Not implemented'); }
 
   /**
    * Handle inbound message payload by creating/updating helpdesk conversation.
    * @param {any} payload
    */
   handleInbound(payload) { throw new Error('Not implemented'); }

  /**
   * Handle normalized update types (message_created, message_edited, etc).
   * @param {string} type
   * @param {any} payload
   */
  handleUpdate(type, payload) { throw new Error('Not implemented'); }
 
   /**
    * Send message to platform.
    * @param {any} target
    * @param {{ text?: string, attachments?: any[], replyTo?: any }} message
    */
   send(target, message) { throw new Error('Not implemented'); }
 }
 
 module.exports = {
   PlatformAdapter
 };
