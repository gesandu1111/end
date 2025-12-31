const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadContentFromMessage,
    getContentType,
    fetchLatestBaileysVersion 
} = require('@adiwajshing/baileys');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs-extra');
const pino = require('pino');
const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
const cmd = text.toLowerCase().trim();
const { downloadContentFromMessage } = require('@adiwajshing/baileys');

const app = express();
const PORT = 3000;

// Dashboard එක සඳහා දත්ත
let connected = false;
let lastMessages = [];

// HTML Dashboard එක සම්බන්ධ කිරීම
app.use(express.static('html'));

// Dashboard එකට දත්ත යවන Endpoint එක
app.get('/status', (req, res) => {
    res.json({
        connected,
        lastMessages
    });
});

app.listen(PORT, () => console.log(`🚀 Dashboard running on: http://localhost:${PORT}`));

// Media download කිරීමට පාවිච්චි කරන function එක
async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    return buffer;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        // QR Code එක ලැබුණු විට එය html folder එකට image එකක් ලෙස සේව් කිරීම
        if (qr) {
            const qrBuffer = await qrcode.toBuffer(qr);
            await fs.ensureDir('./html');
            fs.writeFileSync('./html/qr.png', qrBuffer);
            connected = false;
        }

        if (connection === 'open') {
            connected = true;
            console.log('✅ Bot Online!');
            // කනෙක්ට් වූ පසු QR image එක මකා දැමීම
            if (fs.existsSync('./html/qr.png')) fs.unlinkSync('./html/qr.png');
        }

        if (connection === 'close') {
            connected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    // Anti-Delete logic (Console log එකට පමණි)
    sock.ev.on('messages.update', async (chatUpdate) => {
        for (const { key, update } of chatUpdate) {
            if (update.protocolMessage && update.protocolMessage.type === 0) {
                console.log(`🗑️ Message deleted in: ${key.remoteJid}`);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const mType = getContentType(msg.message);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // Dashboard එකට පණිවිඩය එකතු කිරීම
        lastMessages.push(`${sender.split('@')[0]}: ${text || 'Media Message'}`);
        if (lastMessages.length > 15) lastMessages.shift();

        // --- 1. View Once Photo Download ---
        const viewOnce = msg.message?.viewOnceMessage?.message?.imageMessage || 
                         msg.message?.viewOnceMessageV2?.message?.imageMessage;
        if (viewOnce) {
            const buffer = await downloadMedia(viewOnce, 'image');
            await sock.sendMessage(sender, { image: buffer, caption: '✅ Anti-View Once Captured' }, { quoted: msg });
        }

        // --- 2. Commands (.menu, .ping, .getdp) ---
        const cmd = text.toLowerCase().trim();

        if (cmd === '.menu') {
            const menuText = `┏━━━〔 *PRO BOT MENU* 〕━━━┓
┃
┃ 🤖 *.ping* - Bot Speed
┃ 🖼️ *.getdp* - Get User DP
┃ 👤 *.alive* - Check Status
┃
┗━━━━━━━━━━━━━━━━━━━━┛`;
            await sock.sendMessage(sender, { text: menuText }, { quoted: msg });
        }

        if (cmd === '.ping') {
            await sock.sendMessage(sender, { text: 'Pong! 🏓' }, { quoted: msg });
        }

        if (cmd === '.alive') {
            await sock.sendMessage(sender, { text: 'I am alive and working! ✅' }, { quoted: msg });
        }

        if (cmd.startsWith('.getdp')) {
            try {
                let targetJid = sender;
                if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]) {
                    targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                } else if (msg.message.extendedTextMessage?.contextInfo?.participant) {
                    targetJid = msg.message.extendedTextMessage.contextInfo.participant;
                }
                const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
                await sock.sendMessage(sender, { image: { url: ppUrl }, caption: `✅ DP Downloaded` }, { quoted: msg });
            } catch (e) {
                await sock.sendMessage(sender, { text: '❌ DP fetch failed.' });
            }
        }

         // මැසේජ් එක reply එකක්ද සහ ඒක status එකක්ද කියා බලයි
        if (cmd === '.send' || cmd === '.get') {
    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const isStatus = msg.message.extendedTextMessage?.contextInfo?.participant === 'status@broadcast';

    if (quotedMsg && isStatus) {
        try {
            const mType = Object.keys(quotedMsg)[0]; // imageMessage හෝ videoMessage
            const media = quotedMsg[mType];
            
            // Media එක download කිරීම
            const buffer = await downloadMedia(media, mType.replace('Message', ''));
            
            const caption = `✅ *Status Downloaded Successfully*`;

            if (mType === 'imageMessage') {
                await sock.sendMessage(sender, { image: buffer, caption: caption }, { quoted: msg });
            } else if (mType === 'videoMessage') {
                await sock.sendMessage(sender, { video: buffer, caption: caption, mimetype: 'video/mp4' }, { quoted: msg });
            }
        } catch (e) {
            console.error(e);
            await sock.sendMessage(sender, { text: '❌ Status එක download කිරීමට නොහැකි විය.' });
        }
    } else {
        await sock.sendMessage(sender, { text: '❌ කරුණාකර ඕනෑම Status එකකට Reply එකක් ලෙස .send ලෙස යවන්න.' });
    }
}

        // 1. මේ Import එක index.js එකේ ඉහළින්ම තිබිය යුතුයි
const { downloadContentFromMessage } = require('@adiwajshing/baileys');

/**
 * WhatsApp Media (Image, Video, Audio) Download කරන පොදු Function එක
 * @param {Object} message - ලැබුණු media message එක (eg: msg.message.imageMessage)
 * @param {String} type - Media වර්ගය ('image', 'video', හෝ 'audio')
 * @returns {Buffer} - Download වූ දත්ත (Buffer එකක් ලෙස)
 */
async function downloadMedia(message, type) {
    try {
        // WhatsApp සර්වර් එකෙන් දත්ත ලබා ගැනීම ආරම්භ කරයි
        const stream = await downloadContentFromMessage(message, type);
        let buffer = Buffer.from([]);

        // කොටස් වශයෙන් (chunks) ලැබෙන දත්ත එකතු කරයි
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }

        return buffer; // සම්පූර්ණ දත්ත ගොනුව ලබා දෙයි
    } catch (e) {
        console.error("Media Download Error: ", e);
        return null;
    }
}
        

        // --- 3. Status Download ---
        if (sender === 'status@broadcast') {
            const buffer = await downloadMedia(msg.message[mType], mType.replace('Message', ''));
            await fs.ensureDir('./downloads/status');
            await fs.writeFile(`./downloads/status/${Date.now()}.jpg`, buffer);
        }
    });
}

startBot();
