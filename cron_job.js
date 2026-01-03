require('dotenv').config();
const nodemailer = require('nodemailer');
const moment = require('moment-timezone');
const mongoose = require('mongoose'); // <--- 1. Import Mongoose
const connectDB = require('./db');    // <--- 2. Import your DB connection file
const { getAdsetPerformanceData } = require('./app/api/adset_performance');
const { PDFReport } = require('./app/api/pdf_generator');
const config = require('./config');

// --- UTILS ---
function log(message) {
    const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
    console.log(`[${timestamp}] ${message}`);
}

async function generatePdfBuffer(since, until, label) {
    log(`Generating ${label} PDF...`);
    
    try {
        // 1. Fetch Data
        const data = await getAdsetPerformanceData(since, until, 'order_date');
        const adsetData = data ? data.adsetPerformance : [];

        if (!adsetData || adsetData.length === 0) {
            log(`No adset data for ${label} (${since} to ${until})`);
            return null;
        }

        // 2. Generate PDF Stream
        const report = new PDFReport();
        const doc = report.generate(adsetData, since, until);

        // 3. Convert Stream to Buffer
        return new Promise((resolve, reject) => {
            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                log(`${label} PDF generated successfully (${pdfData.length} bytes)`);
                resolve(pdfData);
            });
            doc.on('error', (err) => {
                console.error("PDF Stream Error:", err);
                reject(err);
            });
        });

    } catch (e) {
        log(`Error generating ${label}: ${e.message}`);
        return null;
    }
}

async function sendEmailWithAttachments(attachments, since, until) {
    const emailUser = config.EMAIL_USER || process.env.EMAIL_USER;
    const emailPass = config.EMAIL_PASSWORD || process.env.EMAIL_PASSWORD;
    const emailHost = config.EMAIL_HOST || process.env.EMAIL_HOST;
    const emailPort = parseInt(config.EMAIL_PORT || process.env.EMAIL_PORT || 587);
    const recipient = config.RECIPIENT_EMAIL || process.env.RECIPIENT_EMAIL;

    if (!emailUser || !emailPass || !emailHost || !recipient) {
        log("[EMAIL ERROR] Missing environment variables (EMAIL_USER, EMAIL_PASSWORD, EMAIL_HOST, RECIPIENT_EMAIL)");
        return;
    }

    try {
        log(`Connecting to SMTP server: ${emailHost}:${emailPort}`);
        
        const transporter = nodemailer.createTransport({
            host: emailHost,
            port: emailPort,
            secure: emailPort === 465, 
            auth: {
                user: emailUser,
                pass: emailPass
            }
        });

        const mailOptions = {
            from: emailUser,
            to: recipient,
            subject: `Ad Set Performance Report: ${since} to ${until}`,
            text: `Attached are the ad set performance reports:\n\n` +
                  `1️⃣ Month-to-Date (${since} to ${until})\n` +
                  `2️⃣ Last Month\n\n` +
                  `Regards,\nEcom Central`,
            attachments: attachments
        };

        const info = await transporter.sendMail(mailOptions);
        log(`✅ Email sent successfully to ${recipient} (MsgID: ${info.messageId})`);

    } catch (e) {
        log(`[EMAIL ERROR] ${e.message}`);
    }
}

async function generateReport() {
    log("=".repeat(60));
    log("Cron job started");
    const startTime = Date.now();

    // 3. CONNECT TO DATABASE HERE
    // We wait for connection before proceeding
    try {
        await connectDB(); 
        log("✅ Database connected for cron job");
    } catch (err) {
        log(`❌ Database connection failed: ${err.message}`);
        process.exit(1); // Stop if no DB
    }

    // Timezone Setup
    const tz = 'Asia/Kolkata';
    const today = moment().tz(tz);

    // 1. Month-to-Date
    const sinceMtd = today.clone().startOf('month').format('YYYY-MM-DD');
    const untilMtd = today.format('YYYY-MM-DD');

    // 2. Last Month
    const lastMonthDate = today.clone().subtract(1, 'months');
    const sinceLastMonth = lastMonthDate.clone().startOf('month').format('YYYY-MM-DD');
    const untilLastMonth = lastMonthDate.clone().endOf('month').format('YYYY-MM-DD');

    log("Generating reports for:");
    log(`  • Month-to-Date: ${sinceMtd} to ${untilMtd}`);
    log(`  • Last Month: ${sinceLastMonth} to ${untilLastMonth}`);

    const attachments = [];

    // Generate PDFs
    const mtdBuffer = await generatePdfBuffer(sinceMtd, untilMtd, "Month-to-Date");
    if (mtdBuffer) {
        attachments.push({
            filename: `adset_report_${sinceMtd}_to_${untilMtd}.pdf`,
            content: mtdBuffer
        });
    }

    const lmBuffer = await generatePdfBuffer(sinceLastMonth, untilLastMonth, "Last Month");
    if (lmBuffer) {
        attachments.push({
            filename: `adset_report_${sinceLastMonth}_to_${untilLastMonth}.pdf`,
            content: lmBuffer
        });
    }

    // Send Email
    if (attachments.length > 0) {
        await sendEmailWithAttachments(attachments, sinceMtd, untilMtd);
    } else {
        log("⚠️ No PDFs generated — skipping email");
    }

    // 4. DISCONNECT DATABASE (Good practice for scripts)
    try {
        await mongoose.connection.close();
        log("Database connection closed");
    } catch (e) {
        console.error("Error closing DB:", e);
    }

    const duration = (Date.now() - startTime) / 1000;
    log(`Cron job completed successfully in ${duration.toFixed(2)} seconds`);
    log("=".repeat(60));
    
    // Explicit exit to prevent PM2 from keeping it stuck if listeners remain
    process.exit(0);
}

// Execute if run directly
if (require.main === module) {
    generateReport();
}

module.exports = { generateReport };