// File: cod_confirmation.js
require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');
const { supabase } = require('./app/supabase');

// --- CONFIGURATION ---
const SPREADSHEET_ID = '1NEmtD6rWngYIXt9KcX7-tAjwxNZmmvf_3QLPBwmj2j8';
const RANGE = 'Sheet1!A:Z';

async function fetchSheetData() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔐 Authenticating with Google...`);

    try {
        let authOptions;
        if (process.env.GOOGLE_CREDENTIALS) {
            let credsStr = process.env.GOOGLE_CREDENTIALS;
            if (credsStr.startsWith("'") && credsStr.endsWith("'")) {
                credsStr = credsStr.slice(1, -1);
            }
            const credentials = JSON.parse(credsStr);
            authOptions = { credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
        } else {
            const KEY_FILE_PATH = path.join(__dirname, 'google_credentials.json');
            authOptions = { keyFile: KEY_FILE_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
        }

        const auth = new google.auth.GoogleAuth(authOptions);
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        console.log("⬇️  Fetching rows...");
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
            valueRenderOption: 'FORMATTED_VALUE',
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('⚠️  No data found.');
            return;
        }

        // --- PROCESSING ---
        const headers = rows[0];
        const dataRows = rows.slice(1);

        // Build records for Supabase upsert
        const records = [];
        for (const row of dataRows) {
            const obj = {};
            headers.forEach((header, index) => {
                let cleanHeader = header.trim();
                let value = row[index] !== undefined ? row[index] : "";

                if (cleanHeader === "Shipping Phone Number") {
                    value = String(value).replace(/[^0-9]/g, '');
                }
                obj[cleanHeader] = value;
            });

            // DEFINE UNIQUE KEY: Use Order ID or Phone Number as the unique identifier
            const uniqueKey = obj["Order Name"] || obj["Order ID"] || obj["Shipping Phone Number"];

            if (uniqueKey) {
                records.push({
                    id_key: uniqueKey,
                    data: obj,
                    updated_at: new Date().toISOString()
                });
            }
        }

        // --- DEDUPLICATE by id_key (keep last occurrence = latest row in sheet) ---
        const deduped = new Map();
        for (const rec of records) {
            deduped.set(rec.id_key, rec);
        }
        const uniqueRecords = Array.from(deduped.values());
        console.log(`📦 ${records.length} rows → ${uniqueRecords.length} unique records`);

        // --- BATCHED SAVING TO SUPABASE ---
        if (uniqueRecords.length > 0) {
            const BATCH_SIZE = 500;
            let savedCount = 0;

            for (let i = 0; i < uniqueRecords.length; i += BATCH_SIZE) {
                const chunk = uniqueRecords.slice(i, i + BATCH_SIZE);
                try {
                    const { error } = await supabase
                        .from('cod_confirmations_ecom')
                        .upsert(chunk, { onConflict: 'id_key' });

                    if (error) {
                        console.error(`\n❌ Error saving batch ${i}: ${error.message}`);
                    } else {
                        savedCount += chunk.length;
                        process.stdout.write(`\r   → Saved ${savedCount}/${uniqueRecords.length}`);
                    }
                } catch (e) {
                    console.error(`\n❌ Error saving batch ${i}: ${e.message}`);
                }
            }
            console.log(`\n✅ Success! Updated Supabase with ${uniqueRecords.length} records.`);
        }

    } catch (error) {
        console.error("❌ Error:", error.message);
    }

    // Close if run directly
    if (require.main === module) {
        process.exit(0);
    }
}

// Run immediately if called directly
if (require.main === module) {
    fetchSheetData();
}

module.exports = { fetchSheetData };
