// api/webhook.js
const axios = require('axios');

// ... (Bagian atas kode tetap sama: BOT_TOKEN, GEMINI_API_KEY, systemInstructionText, userNicknames, dll.) ...
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_MODEL_NAME = "gemini-2.0-flash"; // Gunakan model yang sesuai (Pastikan ini mendukung grounding)
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

let chatHistories = {};
const MAX_HISTORY_LENGTH = 50;

// --- Fungsi sendMessage (Tetap sama, tanpa parse_mode) ---
async function sendMessage(chatId, text, replyToMessageId = null) {
    if (!BOT_TOKEN) {
        console.error("Bot token is not set.");
        return;
    }
    try {
        const MAX_LENGTH = 4096;
        let messageToSend = text;
        if (text && text.length > MAX_LENGTH) {
            messageToSend = text.substring(0, MAX_LENGTH - 20) + "\n... (dipotong)";
            console.warn(`Message to ${chatId} was truncated due to length limit.`);
        } else if (!text) {
            console.warn(`Attempted to send empty message to ${chatId}. Sending fallback.`);
            messageToSend = "(Pesan kosong)";
        }

        const payload = {
            chat_id: chatId,
            text: messageToSend,
            disable_web_page_preview: true
        };
        if (replyToMessageId) { payload.reply_to_message_id = replyToMessageId; }

        await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
        console.log(`Message sent to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
    }
}
// --- Akhir Fungsi sendMessage ---


// --- Fungsi Panggil Gemini (Tetap sama, logic grounding sudah ada) ---
async function getGeminiResponse(chatId, newUserPrompt, userName = 'mas', enableGrounding = false) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set.");
        return { text: "Maaf, konfigurasi AI belum diatur.", parseMode: null };
    }

    let history = chatHistories[chatId] || [];

    if (history.length === 0) {
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
    }
    history.push({ role: "user", parts: [{ text: newUserPrompt }] });

    if (history.length > MAX_HISTORY_LENGTH) {
        console.warn(`History for chat ${chatId} exceeding ${MAX_HISTORY_LENGTH}, trimming...`);
        const systemPromptsCount = history.filter(h => h.role === 'system').length;
        const conversationTurns = (history.length - systemPromptsCount) / 2;
        const turnsToKeep = 5;
        if (conversationTurns > turnsToKeep) {
            const itemsToRemove = (Math.floor(conversationTurns) - turnsToKeep) * 2;
            if (itemsToRemove > 0) {
                history.splice(systemPromptsCount, itemsToRemove);
                console.log(`Trimmed ${itemsToRemove} items from history for chat ${chatId}`);
            }
        }
    }

    const historyBeforeResponse = [...history];
    console.log(`Calling Gemini API for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt}". Grounding: ${enableGrounding}`); // Log akan menunjukkan true/false

    // Request Body
    const requestBody = {
        systemInstruction: { parts: history.filter(h => h.role === 'system').flatMap(h => h.parts) },
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 0.7,
            topP: 0.9,
        },
        // --- TOOL AKTIF JIKA enableGrounding == true ---
        ...(enableGrounding && { tools: [{ 'googleSearchRetrieval': {} }] }) // Cara ringkas menambahkan 'tools' jika grounding aktif
    };

    // --- Hapus logging tools secara eksplisit di sini, cukup log flag `enableGrounding` di atas ---
    // if (enableGrounding) {
    //     console.log("Grounding enabled (googleSearchRetrieval) for this request.");
    // }

    try {
        const response = await axios.post(GEMINI_API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000 // Tingkatkan timeout jika grounding sering timeout
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

        const groundingAttributions = candidate?.citationMetadata?.citationSources;

        if (aiResponseText) {
            console.log("Gemini response text received.");
            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history;

            let finalResponseText = aiResponseText;
            let parseMode = null; // Selalu null

            if (enableGrounding && groundingAttributions && groundingAttributions.length > 0) { // Cek enableGrounding juga
                console.log("Grounding attributions found:", JSON.stringify(groundingAttributions, null, 2));
                finalResponseText += "\n\nSumber:";
                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        title: source.displayName || source.uri
                    }))
                    .filter(source => source.uri)
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri)); // Unik

                if (sources.length > 0) {
                    sources.forEach((source, index) => {
                        finalResponseText += `\n${index + 1}. ${source.title || source.uri}`;
                    });
                    finalResponseText += "\n";
                } else {
                    finalResponseText += " (Tidak dapat memformat sumber)";
                    console.warn("Could not format any valid sources from grounding attributions.");
                }
            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found or response was empty.");
            }

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
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI-nya (mungkin karena grounding), coba lagi aja`; } // Info tambahan timeout
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response && error.response.data && error.response.data.error) {
            errorMsg = `Error dari AI (${error.response.data.error.code || error.response.status}): ${error.response.data.error.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
        }
        return { text: errorMsg, parseMode: null };
    }
}
// --- Akhir Fungsi Gemini ---


// --- Handler Utama Vercel (DIUBAH: enableGrounding default jadi true) ---
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
        // --- UBAH DEFAULT GROUNDING DI SINI ---
        let enableGrounding = true; // Default sekarang AKTIF
        // ---------------------------------------

        let BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        // 1. Handle /clear command
        if (messageText.toLowerCase() === '/clear') {
            isClearCommand = true;
            if (chatHistories[chatId]) {
                delete chatHistories[chatId];
                await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan!`, messageIdToReply);
                console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus.`, messageIdToReply);
            }
            return res.status(200).send('OK');
        }

        // 2. Tentukan pemrosesan AI
        const lowerCaseText = messageText.toLowerCase();

        // Cek /info (Grounding tetap true karena defaultnya sudah true)
        if (lowerCaseText.startsWith('/info ')) {
            promptForAI = messageText.substring(6).trim();
            if (promptForAI) {
                shouldProcessAI = true;
                // enableGrounding = true; // Tidak perlu di set lagi, sudah default
                console.log(`Processing message ${messageId} with '/info' (Grounding ON by default) from ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari info apa pakai /info? Contoh: /info berita terkini tentang AI`, messageIdToReply);
            }
        }
        // Cek private chat (Grounding akan true karena default)
        else if (chatType === 'private') {
            shouldProcessAI = true;
            promptForAI = messageText;
            // enableGrounding = false; // Hapus baris ini agar default true berlaku
            console.log(`Processing private message ${messageId} (Grounding ON by default) from ${nameForAIContext} (${userId})`);
        }
        // Cek group chat (Grounding akan true jika trigger cocok)
        else if (chatType === 'group' || chatType === 'supergroup') {
            let triggerWord = null;
            // Ganti trigger sesuai kebutuhan
            const triggers = ['/chat ', 'bot ', 'tanya '];
            for (const trig of triggers) {
                if (lowerCaseText.startsWith(trig)) {
                    triggerWord = trig;
                    promptForAI = messageText.substring(triggerWord.length).trim();
                    break;
                }
            }

            // Trigger reply
            if (!triggerWord && BOT_USER_ID && message.reply_to_message?.from?.id === BOT_USER_ID) {
                triggerWord = 'reply_to_bot';
                promptForAI = messageText;
            }

            // Konteks balasan
            if (triggerWord && message.reply_to_message && message.reply_to_message.text) {
                const repliedText = message.reply_to_message.text;
                const originalSenderName = message.reply_to_message.from.first_name || (message.reply_to_message.from.username ? `@${message.reply_to_message.from.username}` : `User ${message.reply_to_message.from.id}`);
                promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya berikut: "${promptForAI}"`;
                console.log(`Added context from replied message ${message.reply_to_message.message_id}`);
            }

            if (triggerWord && promptForAI) {
                shouldProcessAI = true;
                // enableGrounding = false; // Hapus baris ini agar default true berlaku
                console.log(`Trigger '${triggerWord.trim()}' activated (Grounding ON by default) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
            } else if (triggerWord && !promptForAI && triggerWord !== 'reply_to_bot') {
                let helpText = `Iya ${nameForBotGreeting}? Mau nanya apa nih? Contoh: ${triggerWord.trim()} jelaskan soal black hole`;
                await sendMessage(chatId, helpText, messageIdToReply);
            } else if (!triggerWord) {
                console.log(`Ignoring non-trigger message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
            }
        } else {
            console.log(`Ignoring message from unsupported chat type: ${chatType}`);
        }

        // 3. Proses AI jika shouldProcessAI true
        if (shouldProcessAI) {
            if (promptForAI.length > 3000) {
                await sendMessage(chatId, `Waduh ${nameForBotGreeting}, pertanyaannya panjang banget. Coba dipersingkat ya.`, messageIdToReply);
            } else {
                try {
                    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }

                // Panggil Gemini, enableGrounding akan bernilai true secara default
                const aiResponseObject = await getGeminiResponse(chatId, promptForAI, nameForAIContext, enableGrounding);

                // Kirim balasan AI
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