const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    downloadContentFromMessage,
    getContentType,
    fetchLatestBaileysVersion 
} = require('@adiwajshing/baileys');
const fs = require('fs-extra');
const pino = require('pino');

// Media download කිරීමට පාවිච්චි කරන පොදු function එක
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

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log('✅ Bot Online! All features active.');
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
    });

    // --- 1. Anti-Delete (මැසේජ් එකක් මැකූ විට එය හඳුනාගැනීම) ---
    sock.ev.on('messages.update', async (chatUpdate) => {
        for (const { key, update } of chatUpdate) {
            if (update.protocolMessage && update.protocolMessage.type === 0) {
                console.log(`🗑️ Message deleted by: ${key.remoteJid}`);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const mType = getContentType(msg.message);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        // --- 2. View Once Photo Download ---
        const viewOnce = msg.message?.viewOnceMessage?.message?.imageMessage || 
                         msg.message?.viewOnceMessageV2?.message?.imageMessage;

        if (viewOnce) {
            console.log('Downloading View Once Media...');
            const buffer = await downloadMedia(viewOnce, 'image');
            await sock.sendMessage(sender, { image: buffer, caption: '✅ Anti-View Once: මම මේක සේව් කරගත්තා!' }, { quoted: msg });
        }

        // --- 3. Status Download ---
        if (sender === 'status@broadcast') {
            const buffer = await downloadMedia(msg.message[mType], mType.replace('Message', ''));
            await fs.ensureDir('./downloads/status');
            const fileName = `./downloads/status/${Date.now()}.jpg`;
            await fs.writeFile(fileName, buffer);
            console.log(`📸 Status Saved: ${fileName}`);
        }

        // --- 4. DP Download Command (.getdp) ---
        if (text.startsWith('.getdp')) {
            try {
                let targetJid = sender;

                // Tag කර ඇත්නම් හෝ Reply කර ඇත්නම් එම කෙනාගේ DP එක ගන්න
                if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0]) {
                    targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
                } else if (msg.message.extendedTextMessage?.contextInfo?.participant) {
                    targetJid = msg.message.extendedTextMessage.contextInfo.participant;
                }

                const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
                await sock.sendMessage(sender, { image: { url: ppUrl }, caption: `✅ DP එක මෙන්න!` }, { quoted: msg });

            } catch (e) {
                await sock.sendMessage(sender, { text: '❌ DP එක ලබාගත නොහැක. (පින්තූරයක් නොමැති වීම හෝ Privacy Settings නිසා)' });
            }
        }
    });
}

startBot();
