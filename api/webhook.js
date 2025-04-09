// api/webhook.js
const axios = require('axios');

// Ambil token & key dari environment variable
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Pastikan ini adalah systemInstruction yang sudah diubah (tanpa instruksi Markdown)
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_MODEL_NAME = "gemini-2.0-flash"; // Gunakan model yang sesuai
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// --- HAPUS Fungsi helper escape ---
// function escapeLegacyMarkdown(text) { ... } // Tidak diperlukan lagi

// --- Fungsi sendMessage (DIUBAH: Tanpa parse_mode sama sekali) ---
async function sendMessage(chatId, text, replyToMessageId = null) { // Hapus parameter parse_mode
    if (!BOT_TOKEN) {
        console.error("Bot token is not set.");
        return;
    }
    try {
        const MAX_LENGTH = 4096; // Batas Telegram
        let messageToSend = text;
        // Pemotongan pesan sederhana
        if (text && text.length > MAX_LENGTH) {
            messageToSend = text.substring(0, MAX_LENGTH - 20) + "\n... (dipotong)";
            console.warn(`Message to ${chatId} was truncated due to length limit.`);
        } else if (!text) {
            console.warn(`Attempted to send empty message to ${chatId}. Sending fallback.`);
            messageToSend = "(Pesan kosong)"; // Fallback jika teks kosong
        }


        const payload = {
            chat_id: chatId,
            text: messageToSend,
            disable_web_page_preview: true
        };
        if (replyToMessageId) { payload.reply_to_message_id = replyToMessageId; }
        // --- TIDAK ADA PENGATURAN parse_mode ---

        await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
        console.log(`Message sent to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));
    } catch (error) {
        // Log error tanpa perlu retry karena parse error
        console.error(`Error sending message to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Mungkin kirim pesan error ke admin jika sering terjadi
    }
}
// --- Akhir Fungsi sendMessage ---

// --- Riwayat & Nama Panggilan (Tetap Sama) ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 50; // Kurangi jika perlu hemat memori/token
// --- Akhir Simulasi Penyimpanan ---

// --- Fungsi Panggil Gemini (DIUBAH: Selalu return parseMode null, format sumber plain text) ---
async function getGeminiResponse(chatId, newUserPrompt, userName = 'mas', enableGrounding = false) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set.");
        return { text: "Maaf, konfigurasi AI belum diatur.", parseMode: null };
    }

    let history = chatHistories[chatId] || [];

    // Tambahkan konteks nama hanya jika history kosong
    if (history.length === 0) {
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
        // Tambahkan system instruction utama (pastikan ini versi TANPA instruksi Markdown)
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
    }
    // Selalu tambahkan prompt pengguna
    history.push({ role: "user", parts: [{ text: newUserPrompt }] });


    // Logic pemotongan history (Sama seperti sebelumnya)
    if (history.length > MAX_HISTORY_LENGTH) {
        console.warn(`History for chat ${chatId} exceeding ${MAX_HISTORY_LENGTH}, trimming...`);
        const systemPromptsCount = history.filter(h => h.role === 'system').length;
        const conversationTurns = (history.length - systemPromptsCount) / 2;
        const turnsToKeep = 5; // Jaga lebih sedikit percakapan untuk hemat token
        if (conversationTurns > turnsToKeep) {
            const itemsToRemove = (Math.floor(conversationTurns) - turnsToKeep) * 2;
            // Hapus dari setelah system prompt awal
            if (itemsToRemove > 0) {
                history.splice(systemPromptsCount, itemsToRemove);
                console.log(`Trimmed ${itemsToRemove} items from history for chat ${chatId}`);
            }
        }
    }

    const historyBeforeResponse = [...history]; // Salin untuk rollback
    console.log(`Calling Gemini API for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt}". Grounding: ${enableGrounding}`);

    // Request Body
    const requestBody = {
        // Pindahkan system instruction ke field khusus jika model mendukung (recommended)
        systemInstruction: { parts: history.filter(h => h.role === 'system').flatMap(h => h.parts) },
        contents: history.filter(h => h.role === 'user' || h.role === 'model'), // Hanya user/model turns
        generationConfig: {
            // Sesuaikan parameter generasi jika perlu (temp 0.7 mungkin cocok untuk gaya informal)
            temperature: 1.0,
            topP: 0.9,
        },
    };

    if (enableGrounding) {
        requestBody.tools = [{
            'google_search': {} // Ganti 'googleSearchRetrieval' menjadi 'google_search'
                                 // Biasanya cukup objek kosong {} sudah cukup
        }];
        console.log("Grounding enabled (googleSearchRetrieval) for this request.");
    }

    try {
        const response = await axios.post(GEMINI_API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000
        });

        const candidate = response.data?.candidates?.[0];
        let aiResponseText = '';

        // Penanganan function call (Sama)
        if (candidate?.content?.parts?.[0]?.functionCall) {
            console.warn("Received functionCall, expected grounding results directly...");
            aiResponseText = candidate?.content?.parts?.find(part => part.text)?.text || '';
        } else {
            aiResponseText = candidate?.content?.parts?.[0]?.text;
        }

        // Ambil metadata grounding
        const groundingAttributions = candidate?.citationMetadata?.citationSources;

        if (aiResponseText) {
            console.log("Gemini response text received.");
            // Tambahkan ke history hanya jika berhasil dan ada teks
            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history; // Update simulasi

            let finalResponseText = aiResponseText;
            // --- SELALU SET parseMode KE null ---
            let parseMode = null;

            // --- PROSES GROUNDING ATTRIBUTIONS (Format plain text) ---
            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", JSON.stringify(groundingAttributions, null, 2));
                finalResponseText += "\n\nSumber:"; // Judul bagian
                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        // Coba ambil judul, fallback ke URI
                        title: source.displayName || source.uri
                    }))
                    .filter(source => source.uri)
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri)); // Unik

                if (sources.length > 0) {
                    sources.forEach((source, index) => {
                        // Tampilkan sebagai daftar teks biasa
                        finalResponseText += `\n${index + 1}. ${source.title || source.uri}`; // Tampilkan judul atau URI
                    });
                    finalResponseText += "\n"; // Spasi setelah daftar
                } else {
                    finalResponseText += " (Tidak dapat memformat sumber)";
                    console.warn("Could not format any valid sources from grounding attributions.");
                }
            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found in response.");
            }

            // Kembalikan teks dan parseMode null
            return { text: finalResponseText.trim(), parseMode: null };

        } else {
            console.error("Gemini response format unexpected or empty text.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse; // Rollback
            return { text: "Waduh, AI-nya lagi diem nih, nggak ngasih jawaban.", parseMode: null };
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        chatHistories[chatId] = historyBeforeResponse; // Rollback
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI-nya. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI-nya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response && error.response.data && error.response.data.error) {
            // Tidak perlu escape pesan error lagi
            errorMsg = `Error dari AI (${error.response.data.error.code || error.response.status}): ${error.response.data.error.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
        }
        return { text: errorMsg, parseMode: null }; // Selalu parseMode null
    }
}
// --- Akhir Fungsi Gemini ---

// --- Handler Utama Vercel (DIUBAH: Hapus parse_mode dari panggilan sendMessage) ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed' }); }
    if (!req.body) { return res.status(200).send('OK - No body'); }

    console.log('Received update:', JSON.stringify(req.body, null, 2));
    const update = req.body;

    if (update.message && update.message.text && update.message.chat) {
        const chatId = update.message.chat.id;
        const message = update.message;
        let messageText = message.text.trim();
        const chatType = message.chat.type;
        const messageId = message.message_id;
        const userId = message.from.id;
        const username = message.from.username;
        const firstName = message.from.first_name;

        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

        let shouldProcessAI = false;
        let promptForAI = "";
        let isClearCommand = false;
        let messageIdToReply = messageId;
        let enableGrounding = false;

        let BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        // 1. Handle /clear command (Tanpa parse_mode)
        if (messageText.toLowerCase() === '/clear') {
            isClearCommand = true;
            if (chatHistories[chatId]) {
                delete chatHistories[chatId];
                await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan!`, messageIdToReply); // Tanpa parse_mode
                console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus.`, messageIdToReply); // Tanpa parse_mode
            }
            return res.status(200).send('OK');
        }

        // 2. Tentukan pemrosesan AI (Logika sama, tapi pesan bantuan tanpa markdown)
        const lowerCaseText = messageText.toLowerCase();

        // Cek /info
        if (lowerCaseText.startsWith('/info ')) {
            promptForAI = messageText.substring(6).trim();
            if (promptForAI) {
                shouldProcessAI = true;
                enableGrounding = true;
                console.log(`Processing message ${messageId} WITH grounding from ${nameForAIContext} (${userId})`);
            } else {
                // Pesan bantuan tanpa backtick
                await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari info apa pakai /info? Contoh: /info berita terkini tentang AI`, messageIdToReply);
            }
        }
        // Cek trigger lain
        else if (chatType === 'private') {
            shouldProcessAI = true;
            promptForAI = messageText;
            enableGrounding = false;
            console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
        } else if (chatType === 'group' || chatType === 'supergroup') {
            let triggerWord = null;
            const triggers = ['/chat ', 'lele ','le ' , 'tanya ']; // Contoh trigger baru
            for (const trig of triggers) {
                if (lowerCaseText.startsWith(trig)) {
                    triggerWord = trig;
                    promptForAI = messageText.substring(triggerWord.length).trim();
                    break; // Hentikan setelah trigger pertama ditemukan
                }
            }

            // Trigger reply tetap sama
            if (!triggerWord && BOT_USER_ID && message.reply_to_message?.from?.id === BOT_USER_ID) {
                triggerWord = 'reply_to_bot';
                promptForAI = messageText;
            }


            // Konteks balasan (Sama)
            if (triggerWord && message.reply_to_message && message.reply_to_message.text) {
                const repliedText = message.reply_to_message.text;
                const originalSenderName = message.reply_to_message.from.first_name || (message.reply_to_message.from.username ? `@${message.reply_to_message.from.username}` : `User ${message.reply_to_message.from.id}`);
                promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya berikut: "${promptForAI}"`;
                console.log(`Added context from replied message ${message.reply_to_message.message_id}`);
            }

            if (triggerWord && promptForAI) {
                shouldProcessAI = true;
                enableGrounding = false;
                console.log(`Trigger '${triggerWord.trim()}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
            } else if (triggerWord && !promptForAI && triggerWord !== 'reply_to_bot') {
                // Pesan bantuan tanpa backtick
                let helpText = `Iya ${nameForBotGreeting}? Mau nanya apa nih? Contoh: ${triggerWord.trim()} jelaskan soal black hole`;
                await sendMessage(chatId, helpText, messageIdToReply);
            } else if (!triggerWord) {
                console.log(`Ignoring non-trigger message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
            }
        } else {
            console.log(`Ignoring message from unsupported chat type: ${chatType}`);
        }

        // 3. Proses AI (Pemanggilan getGeminiResponse mengembalikan parseMode null)
        if (shouldProcessAI) {
            if (promptForAI.length > 3000) {
                // Pesan error tanpa markdown
                await sendMessage(chatId, `Waduh ${nameForBotGreeting}, pertanyaannya panjang banget. Coba dipersingkat ya.`, messageIdToReply);
            } else {
                try {
                    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }

                const aiResponseObject = await getGeminiResponse(chatId, promptForAI, nameForAIContext, enableGrounding);

                // Kirim balasan AI (parameter parseMode diabaikan karena null)
                await sendMessage(chatId, aiResponseObject.text, messageIdToReply);
            }
        }

    } else if (update.message && update.message.chat) {
        console.log(`Ignoring non-text message update in chat ${update.message.chat.id}`);
    } else {
        console.log('Ignoring update that is not a message or lacks required fields.');
    }

    res.status(200).send('OK');
};