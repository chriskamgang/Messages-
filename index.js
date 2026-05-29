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
import fs from 'fs';

const PORT = process.env.PORT || 3001;
const API_SECRET = process.env.API_SECRET || '';

const logger = pino({ level: 'silent' });

const app = express();
app.use(express.json());

// ─── Multi-sessions ────────────────────────────────────────────────────────────
// Map sessionId -> { sock, isConnected, qrCodeData }
const sessions = new Map();

// File de messages avec rate limiting
// { phone, message, sessionId (optionnel) }
const messageQueue = [];
let isSending = false;
let messagesSentInBatch = 0;
const BATCH_SIZE = 5;          // messages avant pause
const PAUSE_MS   = 2 * 60 * 1000; // 2 minutes

// ─── Middleware auth ───────────────────────────────────────────────────────────
function requireSecret(req, res, next) {
    if (!API_SECRET) return next();
    const token = req.headers['x-api-secret'];
    if (token !== API_SECRET) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    next();
}

// ─── Connexion d'une session ───────────────────────────────────────────────────
async function connectSession(sessionId) {
    const sessionDir = `./sessions/${sessionId}`;
    fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        printQRInTerminal: true,
        browser: ['SystemRH', 'Chrome', '1.0.0'],
    });

    sessions.set(sessionId, { sock, isConnected: false, qrCodeData: null });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const session = sessions.get(sessionId);
        if (!session) return;

        if (qr) {
            session.qrCodeData = await QRCode.toDataURL(qr);
            session.isConnected = false;
            console.log(`[${sessionId}] QR disponible sur /qr/${sessionId}`);
        }

        if (connection === 'close') {
            session.isConnected = false;
            session.qrCodeData = null;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(`[${sessionId}] Connexion fermée, raison: ${reason}`);

            if (reason === DisconnectReason.loggedOut) {
                console.log(`[${sessionId}] Déconnecté. Supprimez ./sessions/${sessionId} et reconnectez.`);
                sessions.delete(sessionId);
            } else {
                console.log(`[${sessionId}] Reconnexion dans 5s...`);
                setTimeout(() => connectSession(sessionId), 5000);
            }
        }

        if (connection === 'open') {
            session.isConnected = true;
            session.qrCodeData = null;
            console.log(`[${sessionId}] Connecté !`);
        }
    });
}

// ─── Traitement de la file avec rate limiting ──────────────────────────────────
async function processQueue() {
    if (isSending || messageQueue.length === 0) return;
    isSending = true;

    while (messageQueue.length > 0) {
        // Pause après chaque batch de BATCH_SIZE messages
        if (messagesSentInBatch >= BATCH_SIZE) {
            console.log(`[Queue] ${BATCH_SIZE} messages envoyés — pause de ${PAUSE_MS / 1000}s...`);
            messagesSentInBatch = 0;
            await new Promise(resolve => setTimeout(resolve, PAUSE_MS));
        }

        const item = messageQueue.shift();

        // Choisir la session : celle demandée, sinon round-robin sur les connectées
        let targetSession = null;
        if (item.sessionId && sessions.has(item.sessionId) && sessions.get(item.sessionId).isConnected) {
            targetSession = sessions.get(item.sessionId);
        } else {
            // Prendre la première session connectée
            for (const [, session] of sessions) {
                if (session.isConnected) { targetSession = session; break; }
            }
        }

        if (!targetSession) {
            console.warn(`[Queue] Aucune session connectée — message ignoré vers ${item.phone}`);
            continue;
        }

        try {
            const normalized = item.phone.replace(/[^\d]/g, '');
            const jid = normalized + '@s.whatsapp.net';
            await targetSession.sock.sendMessage(jid, { text: item.message });
            console.log(`[Queue] Message envoyé à ${jid}`);
            messagesSentInBatch++;

            // Délai aléatoire entre messages (1-3s) pour paraître humain
            await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
        } catch (err) {
            console.error(`[Queue] Erreur envoi vers ${item.phone}:`, err.message);
        }
    }

    isSending = false;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /sessions — liste toutes les sessions
app.get('/sessions', requireSecret, (req, res) => {
    const list = [];
    for (const [id, session] of sessions) {
        list.push({ id, connected: session.isConnected, waiting_qr: !!session.qrCodeData });
    }
    res.json({ success: true, sessions: list, queue_size: messageQueue.length });
});

// POST /sessions/add — ajouter une nouvelle session
app.post('/sessions/add', requireSecret, async (req, res) => {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ success: false, message: 'session_id requis' });
    if (sessions.has(session_id)) return res.status(400).json({ success: false, message: 'Session déjà existante' });

    await connectSession(session_id);
    res.json({ success: true, message: `Session "${session_id}" créée. Scannez sur /qr/${session_id}` });
});

// DELETE /sessions/:id — supprimer une session
app.delete('/sessions/:id', requireSecret, async (req, res) => {
    const { id } = req.params;
    if (!sessions.has(id)) return res.status(404).json({ success: false, message: 'Session introuvable' });

    const session = sessions.get(id);
    try { await session.sock.logout(); } catch {}
    sessions.delete(id);

    // Supprimer les fichiers de session
    fs.rmSync(`./sessions/${id}`, { recursive: true, force: true });
    res.json({ success: true, message: `Session "${id}" supprimée` });
});

// GET /qr/:sessionId — afficher le QR d'une session
app.get('/qr/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.send(`<h2>Session "${req.params.sessionId}" introuvable.</h2>`);
    if (session.isConnected) return res.send(`<h2 style="color:green">Session "${req.params.sessionId}" connectée !</h2>`);
    if (!session.qrCodeData) return res.send('<h2>En attente du QR... Rafraîchissez dans quelques secondes.</h2>');

    res.send(`
        <!DOCTYPE html><html>
        <head><title>QR - ${req.params.sessionId}</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px;">
            <h2>Session : ${req.params.sessionId}</h2>
            <p>Ouvrez WhatsApp > Appareils liés > Lier un appareil</p>
            <img src="${session.qrCodeData}" style="width:300px;height:300px;" />
            <script>setTimeout(() => location.reload(), 10000);</script>
        </body></html>
    `);
});

// GET /qr — rétrocompatibilité : QR de la session "default"
app.get('/qr', (req, res) => {
    const session = sessions.get('default');
    if (!session) return res.send('<h2>Aucune session "default". Créez-en une via POST /sessions/add</h2>');
    if (session.isConnected) return res.send('<h2 style="color:green">WhatsApp connecté !</h2>');
    if (!session.qrCodeData) return res.send('<h2>En attente du QR... Rafraîchissez.</h2>');

    res.send(`
        <!DOCTYPE html><html>
        <head><title>WhatsApp QR</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px;">
            <h2>Scannez ce QR avec WhatsApp</h2>
            <p>Ouvrez WhatsApp > Appareils liés > Lier un appareil</p>
            <img src="${session.qrCodeData}" style="width:300px;height:300px;" />
            <script>setTimeout(() => location.reload(), 10000);</script>
        </body></html>
    `);
});

// GET /status — état général
app.get('/status', requireSecret, (req, res) => {
    let anyConnected = false;
    for (const [, s] of sessions) { if (s.isConnected) { anyConnected = true; break; } }
    res.json({
        success: true,
        connected: anyConnected,
        sessions: sessions.size,
        queue_size: messageQueue.length,
        messages_in_batch: messagesSentInBatch,
    });
});

// POST /send-message — mettre un message en file (rétrocompatible)
app.post('/send-message', requireSecret, async (req, res) => {
    const { phone, message, session_id } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ success: false, message: 'phone et message requis' });
    }

    let anyConnected = false;
    for (const [, s] of sessions) { if (s.isConnected) { anyConnected = true; break; } }
    if (!anyConnected) {
        return res.status(503).json({ success: false, message: 'Aucune session WhatsApp connectée. Scannez un QR.' });
    }

    messageQueue.push({ phone, message, sessionId: session_id || null });
    processQueue(); // démarrer la file si pas déjà en cours

    res.json({ success: true, message: 'Message mis en file', queue_size: messageQueue.length });
});

// ─── Demarrage ────────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, async () => {
    console.log(`[WhatsApp Service] Démarré sur http://localhost:${PORT}`);

    // Charger les sessions existantes depuis ./sessions/
    if (fs.existsSync('./sessions')) {
        const dirs = fs.readdirSync('./sessions').filter(f =>
            fs.statSync(`./sessions/${f}`).isDirectory()
        );
        if (dirs.length === 0) {
            // Créer la session par défaut
            console.log('[WhatsApp Service] Création session "default"...');
            await connectSession('default');
        } else {
            for (const dir of dirs) {
                console.log(`[WhatsApp Service] Chargement session "${dir}"...`);
                await connectSession(dir);
            }
        }
    } else {
        await connectSession('default');
    }
});
