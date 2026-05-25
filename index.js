import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || '';

const logger = pino({ level: 'silent' });

const app = express();
app.use(express.json());

// State
let sock = null;
let qrCodeData = null;   // base64 PNG du QR
let isConnected = false;

// ─── Middleware auth ───────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    if (!API_SECRET) return next();
    const token = req.headers['x-api-secret'];
    if (token !== API_SECRET) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
}

// ─── Connexion Baileys ─────────────────────────────────────────────────────────
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./sessions');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger,
        auth: state,
        printQRInTerminal: true,
        browser: ['Estuaire Emploie', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeData = await QRCode.toDataURL(qr);
            isConnected = false;
            console.log('[WhatsApp] QR code généré — scannez sur http://localhost:' + PORT + '/qr');
        }

        if (connection === 'close') {
            isConnected = false;
            qrCodeData = null;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('[WhatsApp] Connexion fermée, raison:', reason);

            if (reason === DisconnectReason.loggedOut) {
                console.log('[WhatsApp] Déconnecté (logged out). Supprimez ./sessions et redémarrez.');
            } else {
                console.log('[WhatsApp] Reconnexion...');
                setTimeout(connectToWhatsApp, 5000);
            }
        }

        if (connection === 'open') {
            isConnected = true;
            qrCodeData = null;
            console.log('[WhatsApp] Connecté avec succes !');
        }
    });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /qr — affiche le QR code en HTML pour le scanner
app.get('/qr', (req, res) => {
    if (isConnected) {
        return res.send('<h2 style="color:green">WhatsApp est connecte !</h2>');
    }
    if (!qrCodeData) {
        return res.send('<h2>En attente du QR code... Rafraichissez dans quelques secondes.</h2>');
    }
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>WhatsApp QR</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px;">
            <h2>Scannez ce QR avec WhatsApp</h2>
            <p>Ouvrez WhatsApp > Appareils lies > Lier un appareil</p>
            <img src="${qrCodeData}" style="width:300px;height:300px;" />
            <p style="color:#888;margin-top:20px;">Cette page se rafraichit automatiquement</p>
            <script>setTimeout(() => location.reload(), 10000);</script>
        </body>
        </html>
    `);
});

// GET /status — etat de la connexion
app.get('/status', requireSecret, (req, res) => {
    res.json({
        success: true,
        connected: isConnected,
        waiting_for_qr: !isConnected && !!qrCodeData,
    });
});

// POST /send-message — envoyer un message
app.post('/send-message', requireSecret, async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ success: false, message: 'phone et message requis' });
    }

    if (!isConnected || !sock) {
        return res.status(503).json({ success: false, message: 'WhatsApp non connecte. Scannez le QR sur /qr' });
    }

    try {
        // Normaliser le numero : retirer +, espaces, tirets
        const normalized = phone.replace(/[^\d]/g, '');
        const jid = normalized + '@s.whatsapp.net';

        await sock.sendMessage(jid, { text: message });

        console.log(`[WhatsApp] Message envoye a ${jid}`);
        res.json({ success: true, message: 'Message envoye', to: jid });
    } catch (err) {
        console.error('[WhatsApp] Erreur envoi:', err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ─── Demarrage ────────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, () => {
    console.log(`[WhatsApp Service] Demarre sur http://localhost:${PORT}`);
    console.log(`[WhatsApp Service] QR code disponible sur http://localhost:${PORT}/qr`);
});

connectToWhatsApp();
