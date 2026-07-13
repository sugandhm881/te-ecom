// Load .env and keep the file's own values. A stray machine/user-level env var (e.g. PORT=4000 set by
// another tool) would otherwise win over .env, since dotenv never overrides an existing env var — so for
// PORT we prefer the .env file value to keep this app on its configured port.
const _envFile = require('dotenv').config().parsed || {};
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || '.';

module.exports = {
    PORT: _envFile.PORT || process.env.PORT || 5001,
    SECRET_KEY: process.env.JWT_SECRET,

    // --- Dashboard Login ---
    APP_USER_EMAIL: process.env.APP_USER_EMAIL,
    APP_USER_PASSWORD: process.env.APP_USER_PASSWORD,

    // --- Email Reporting ---
    EMAIL_HOST: process.env.EMAIL_HOST,
    EMAIL_PORT: process.env.EMAIL_PORT,
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
    RECIPIENT_EMAIL: process.env.RECIPIENT_EMAIL,
    
    // --- Shopify ---
    SHOPIFY_TOKEN: process.env.SHOPIFY_TOKEN,
    SHOPIFY_SHOP_URL: process.env.SHOPIFY_SHOP_URL,

    // --- Amazon ---
    AWS_ACCESS_KEY: process.env.AWS_ACCESS_KEY,
    AWS_SECRET_KEY: process.env.AWS_SECRET_KEY,
    AWS_REGION: process.env.AWS_REGION,
    LWA_CLIENT_ID: process.env.LWA_CLIENT_ID,
    LWA_CLIENT_SECRET: process.env.LWA_CLIENT_SECRET,
    REFRESH_TOKEN: process.env.REFRESH_TOKEN,
    MARKETPLACE_ID: process.env.MARKETPLACE_ID,
    BASE_URL: process.env.BASE_URL || 'https://sellingpartnerapi-eu.amazon.com',
    
    // --- Facebook Ads ---
    FACEBOOK_AD_ACCOUNT_ID: process.env.FACEBOOK_AD_ACCOUNT_ID,
    FACEBOOK_ACCESS_TOKEN: process.env.FACEBOOK_ACCESS_TOKEN,

    // --- Logistics ---
    RAPIDSHYP_API_KEY: process.env.RAPIDSHYP_API_KEY,
    RAPIDSHYP_API_URL: process.env.RAPIDSHYP_API_URL || 'https://api.rapidshyp.com/rapidshyp/apis/v1/',
    DOCPHARMA_API_KEY: process.env.DOCPHARMA_API_KEY,
    // Warehouse origin pincode used for serviceability / EDD estimates
    PICKUP_PINCODE: process.env.PICKUP_PINCODE || '122101',
    // Slack word that triggers the DocPharma→MWH report. LIVE leaves this unset → "rejected";
    // LOCAL test instance sets DP_TRIGGER_WORD=test so the two don't both fire on one message.
    DP_TRIGGER_WORD: process.env.DP_TRIGGER_WORD,

    // --- EasyEcom OMS ---
    EASYECOM_BASE_URL: process.env.EASYECOM_BASE_URL || 'https://app.easyecom.io',
    EASYECOM_API_KEY: process.env.EASYECOM_API_KEY,
    EASYECOM_WH_KEY: process.env.EASYECOM_WH_KEY,
    EASYECOM_JWT: process.env.EASYECOM_JWT,
    EASYECOM_EMAIL: process.env.EASYECOM_EMAIL,
    EASYECOM_PASSWORD: process.env.EASYECOM_PASSWORD,
    EASYECOM_WEBHOOK_TOKEN: process.env.EASYECOM_WEBHOOK_TOKEN,

    // --- Supabase ---
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,

    // --- Amazon Auto Review ---
    SLACK_BOT_TOKEN:   process.env.SLACK_BOT_TOKEN,
    SLACK_CHANNEL_ID:  process.env.SLACK_CHANNEL_ID || 'C0BDDKPE3PS',

    // --- Microsoft Teams (report webhooks) — Workflows "incoming webhook" URLs, one per channel ---
    TEAMS_WEBHOOK_WAREHOUSE: process.env.TEAMS_WEBHOOK_WAREHOUSE,
    TEAMS_WEBHOOK_DP:        process.env.TEAMS_WEBHOOK_DP,
    TEAMS_WEBHOOK_HOLD:      process.env.TEAMS_WEBHOOK_HOLD,
    TEAMS_WEBHOOK_AMAZON:    process.env.TEAMS_WEBHOOK_AMAZON,
    DASHBOARD_URL:     process.env.DASHBOARD_URL || 'http://72.60.97.42:5002',
    AUTO_REVIEW_CRON:  process.env.AUTO_REVIEW_CRON || '0 10 * * *',

    // --- Cache Files ---
    CACHE_DIR: CACHE_DIR,
    AMAZON_CACHE_FILE: path.join(CACHE_DIR, process.env.AMAZON_CACHE_FILE || 'amazon_cache.json'),
    AMAZON_ITEMS_CACHE_FILE: path.join(CACHE_DIR, process.env.AMAZON_ITEMS_CACHE_FILE || 'amazon_items_cache.json'),
    RAPIDSHYP_CACHE_FILE: path.join(CACHE_DIR, process.env.RAPIDSHYP_CACHE_FILE || 'rapidshyp_cache.json'),
    MASTER_DATA_FILE: path.join(CACHE_DIR, 'master_order_data.json'),
    AMAZON_CACHE_DATE_FILE: path.join(CACHE_DIR, 'amazon_cache_date.txt')
};