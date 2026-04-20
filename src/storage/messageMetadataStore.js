'use strict';

let Pool = null;
try {
  ({ Pool } = require('pg'));
} catch (_) {
  Pool = null;
}

class MessageMetadataStore {
  constructor({ connectionString }) {
    this.pool = Pool ? new Pool({ connectionString }) : null;
    this.initialized = false;
    this.enabled = !!this.pool;
    if (!this.enabled) {
      console.warn('[MESSAGES META] disabled: module "pg" is not installed');
    }
  }

  async init() {
    if (!this.enabled) return;
    if (this.initialized) return;
    await this.pool.query('ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS direction text');
    await this.pool.query('ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS platform text');
    this.initialized = true;
  }

  async annotateMessage(messageId, { direction, platform }) {
    if (!this.enabled) return;
    if (!messageId) return;
    await this.init();
    await this.pool.query(
      `UPDATE public.messages
       SET direction = COALESCE($2, direction),
           platform = COALESCE($3, platform)
       WHERE id = $1`,
      [Number(messageId), direction || null, platform || null]
    );
  }
}

module.exports = {
  MessageMetadataStore
};
