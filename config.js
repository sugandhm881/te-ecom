require('dotenv').config();
const path = require('path');

const CACHE_DIR = process.env.CACHE_DIR || '.';

module.exports = {
    PORT: process.env.PORT || 5001,
    SECRET_KEY: process.env.JWT_SECRET || 'you-should-really-change-this',

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
    DOCPHARMA_API_KEY: process.env.DOCPHARMA_API_KEY,

    // --- Cache Files ---
    CACHE_DIR: CACHE_DIR,
    AMAZON_CACHE_FILE: path.join(CACHE_DIR, process.env.AMAZON_CACHE_FILE || 'amazon_cache.json'),
    AMAZON_ITEMS_CACHE_FILE: path.join(CACHE_DIR, process.env.AMAZON_ITEMS_CACHE_FILE || 'amazon_items_cache.json'),
    RAPIDSHYP_CACHE_FILE: path.join(CACHE_DIR, process.env.RAPIDSHYP_CACHE_FILE || 'rapidshyp_cache.json'),
    MASTER_DATA_FILE: path.join(CACHE_DIR, 'master_order_data.json'),
    AMAZON_CACHE_DATE_FILE: path.join(CACHE_DIR, 'amazon_cache_date.txt')
};