// File: cod_confirmation.js
require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const SPREADSHEET_ID = '1NEmtD6rWngYIXt9KcX7-tAjwxNZmmvf_3QLPBwmj2j8'; 
const RANGE = 'Sheet1!A:Z'; 
// Save explicitly to the project root
const OUTPUT_FILE = path.join(__dirname, 'COD_Confirmation.json'); 

async function fetchSheetData() {
    console.log(`[${new Date().toLocaleTimeString()}] 🔐 Authenticating with Google...`);

    try {
        let authOptions;
        if (process.env.GOOGLE_CREDENTIALS) {
            const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
            authOptions = { credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
        } else {
            const KEY_FILE_PATH = path.join(__dirname, 'service_account.json');
            if (fs.existsSync(KEY_FILE_PATH)) {
                authOptions = { keyFile: KEY_FILE_PATH, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] };
            } else {
                throw new Error("❌ No credentials found!");
            }
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

        const jsonArray = dataRows.map((row) => {
            let obj = {};
            headers.forEach((header, index) => {
                let cleanHeader = header.trim();
                let value = row[index] !== undefined ? row[index] : "";
                
                // Keep phones as strings, remove symbols
                if (cleanHeader === "Shipping Phone Number") {
                    value = String(value).replace(/[^0-9]/g, ''); 
                }
                
                obj[cleanHeader] = value;
            });
            return obj;
        });

        // --- SAVING ---
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(jsonArray, null, 2));
        console.log(`✅ Success! Updated ${OUTPUT_FILE} with ${jsonArray.length} records.`);

    } catch (error) {
        console.error("❌ Error:", error.message);
    }
}

// Run immediately when called
fetchSheetData();