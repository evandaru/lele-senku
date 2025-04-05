// api/webhook.js
const axios = require('axios');

// Ambil token & key dari environment variable
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_MODEL_NAME = "models/gemini-2.0-flash"; // Atau model lain
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// --- Fungsi helper untuk escape Markdown Legacy ---
function escapeLegacyMarkdown(text) {
    if (!text) return '';
    // Karakter utama yang perlu di-escape dalam konteks teks Markdown legacy: *, _, `
    // Kita tidak perlu escape [ atau ] secara umum KECUALI jika membuat bingung parser link,
    // tapi untuk kesederhanaan dalam teks biasa, hanya escape *, _, `
    const charsToEscape = /([*_`])/g;
    return text.replace(charsToEscape, '\\$1');
    // Catatan: Jika Anda membuat link [text](url), URL biasanya tidak perlu di-escape,
    // dan 'text' hanya perlu di-escape *, _, ` di dalamnya.
}

// --- Fungsi sendMessage (Menggunakan parse_mode: 'Markdown') ---
async function sendMessage(chatId, text, replyToMessageId = null, parse_mode = null) {
    if (!BOT_TOKEN) { /*...*/ return; }
    try {
        const MAX_LENGTH = 9096;
        let messageToSend = text;
        // Pemotongan pesan (logika bisa disederhanakan untuk legacy markdown)
        if (text.length > MAX_LENGTH) {
            messageToSend = text.substring(0, MAX_LENGTH - 20); // Potong lebih awal
            // Hapus karakter format legacy potensial di akhir
            messageToSend = messageToSend.replace(/[*_`]$/, '');
            messageToSend += "\n... (dipotong)";
            console.warn(`Message to ${chatId} was truncated due to length limit.`);
        }

        const payload = {
            chat_id: chatId,
            text: messageToSend,
            disable_web_page_preview: true // Tetap berguna
        };
        if (replyToMessageId) { payload.reply_to_message_id = replyToMessageId; }
        // --- Set parse_mode JIKA ada, gunakan 'Markdown' legacy ---
        if (parse_mode && parse_mode.toLowerCase() === 'markdown') {
            payload.parse_mode = 'Markdown'; // Gunakan Markdown Legacy
        }

        await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
        console.log(`Message sent to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : '') + (payload.parse_mode ? ` with parse_mode=${payload.parse_mode}` : ''));
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Retry logic jika parse error (meskipun lebih jarang di legacy)
        if (parse_mode && error.response && error.response.data && error.response.data.description && error.response.data.description.toLowerCase().includes('parse error')) {
            console.warn(`Retrying message to ${chatId} without parse_mode due to formatting error (Legacy Markdown). Original error: ${error.response.data.description}`);
            await sendMessage(chatId, text, replyToMessageId, null); // Kirim teks asli
        } else if (error.response && error.response.data && error.response.data.error_code === 400) {
            console.warn(`Retrying message to ${chatId} without parse_mode due to generic bad request (maybe formatting - Legacy Markdown). Original error: ${error.response.data.description}`);
            await sendMessage(chatId, text, replyToMessageId, null);
        }
    }
}
// --- Akhir Fungsi sendMessage ---

// --- Riwayat & Nama Panggilan (Tetap Sama) ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 100;
// --- Akhir Simulasi Penyimpanan ---

// --- Fungsi Panggil Gemini (DIMODIFIKASI: Default ke parseMode 'Markdown', gunakan escapeLegacyMarkdown) ---
async function getGeminiResponse(chatId, newUserPrompt, userName = 'mas', enableGrounding = false) {
    if (!GEMINI_API_KEY) { /*...*/ return { text: "Maaf, konfigurasi AI belum diatur.", parseMode: null }; }

    let history = chatHistories[chatId] || [];
    if (history.length === 0) {
        // Instruksi sistem awal bisa menyarankan format Markdown sederhana jika perlu
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}. Sapa atau gunakan nama ini sesekali jika relevan. Gunakan format *bold* untuk penekanan penting dan _italic_ untuk nuansa. Gunakan \`code\` untuk istilah teknis atau perintah.` }] });
        // Tambahkan instruksi sistem utama Anda
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
    }
    history.push({ role: "user", parts: [{ text: newUserPrompt }] });

    // Logic pemotongan history (Sama)
    if (history.length > MAX_HISTORY_LENGTH) {
        console.warn(`History for chat ${chatId} exceeding ${MAX_HISTORY_LENGTH}, trimming...`);
        const systemPromptsCount = history.filter(h => h.role === 'system').length;
        const conversationTurns = (history.length - systemPromptsCount) / 2;
        const turnsToKeep = 10;
        if (conversationTurns > turnsToKeep) {
            const itemsToRemove = (Math.floor(conversationTurns) - turnsToKeep) * 2;
            history.splice(systemPromptsCount, itemsToRemove);
            console.log(`Trimmed ${itemsToRemove} items from history for chat ${chatId}`);
        }
    }

    const historyBeforeResponse = [...history];
    console.log(`Calling Gemini API for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt}". Grounding: ${enableGrounding}`);

    // Request Body (System Instruction dipindah ke field khusus jika didukung model, jika tidak gabungkan ke history)
    // Cek dokumentasi model Anda, contoh ini menggunakan field khusus
    const requestBody = {
        systemInstruction: { parts: history.filter(h => h.role === 'system').flatMap(h => h.parts) }, // Gabungkan semua system parts
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 0.5,
            topP: 0.9,
        },
    };

    if (enableGrounding) {
        requestBody.tools = [{ 'googleSearchRetrieval': {} }];
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

        const groundingAttributions = candidate?.citationMetadata?.citationSources;

        if (aiResponseText) {
            console.log("Gemini response text received.");
            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history;

            let finalResponseText = aiResponseText;
            // ++ GUNAKAN MARKDOWN LEGACY SEBAGAI DEFAULT ++
            let parseMode = 'Markdown'; // Default ke Markdown Legacy

            // ++ PROSES GROUNDING ATTRIBUTIONS (Gunakan escapeLegacyMarkdown) ++
            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", JSON.stringify(groundingAttributions, null, 2));
                finalResponseText += "\n\n*Sumber:*"; // Italic tetap sama
                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        title: source.displayName || source.uri?.split('/')[2]?.split('?')[0] || 'Sumber tidak dikenal'
                    }))
                    .filter(source => source.uri)
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri));

                if (sources.length > 0) {
                    sources.forEach((source, index) => {
                        // Gunakan escapeLegacyMarkdown hanya untuk judul
                        const escapedTitle = escapeLegacyMarkdown(source.title);
                        // URL biasanya tidak perlu di-escape di legacy, kecuali mengandung ')'
                        const uriToUse = source.uri.includes(')') ? encodeURI(source.uri) : source.uri; // Encode jika ada ')'
                        finalResponseText += `\n${index + 1}. [${escapedTitle}](${uriToUse})`; // Format link tetap sama
                    });
                    finalResponseText += "\n";
                } else {
                    finalResponseText += " (Tidak dapat memformat sumber)";
                    console.warn("Could not format any valid sources from grounding attributions.");
                }
            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found in response.");
            }

            // Kembalikan teks dan parse mode 'Markdown'
            return { text: finalResponseText.trim(), parseMode: parseMode };

        } else {
            console.error("Gemini response format unexpected or empty text.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse;
            return { text: "Waduh, AI-nya lagi bingung nih, responsnya kosong.", parseMode: null };
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        chatHistories[chatId] = historyBeforeResponse;
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI-nya. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI-nya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response && error.response.data && error.response.data.error) {
            // Escape pesan error menggunakan legacy markdown escape
            errorMsg = `Error dari AI (${error.response.data.error.code || error.response.status}): ${escapeLegacyMarkdown(error.response.data.error.message || 'Gagal memproses')}. Coba cek lagi ${userName}`;
        }
        return { text: errorMsg, parseMode: null }; // Pesan error sebaiknya tanpa parse mode
    }
}
// --- Akhir Fungsi Gemini ---

// --- Handler Utama Vercel (Update parse_mode ke 'Markdown') ---
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

        // 1. Handle /clear command (Gunakan 'Markdown', hapus escape tidak perlu)
        if (messageText.toLowerCase() === '/clear') {
            isClearCommand = true;
            if (chatHistories[chatId]) {
                delete chatHistories[chatId];
                // Hapus escape '\!' dan '\.'
                await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan!`, messageIdToReply, 'Markdown');
                console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus.`, messageIdToReply, 'Markdown');
            }
            return res.status(200).send('OK');
        }

        // 2. Tentukan pemrosesan AI (Logika sama, tapi parse_mode di sendMessage akan jadi 'Markdown')
        const lowerCaseText = messageText.toLowerCase();

        if (lowerCaseText.startsWith('/info ')) {
            promptForAI = messageText.substring(6).trim();
            if (promptForAI) {
                shouldProcessAI = true;
                enableGrounding = true;
                console.log(`Processing message ${messageId} WITH grounding from ${nameForAIContext} (${userId})`);
            } else {
                // Gunakan 'Markdown' untuk pesan bantuan
                await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari info apa pakai /info? Contoh: \`/info berita terkini tentang AI\``, messageIdToReply, 'Markdown');
            }
        }
        else if (chatType === 'private') {
            shouldProcessAI = true;
            promptForAI = messageText;
            enableGrounding = false;
            console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
        } else if (chatType === 'group' || chatType === 'supergroup') {
            let triggerWord = null;
            if (lowerCaseText.startsWith('/chat ')) {
                triggerWord = '/chat ';
                promptForAI = messageText.substring(triggerWord.length).trim(); // Ambil setelah trigger
            } else if (BOT_USER_ID && message.reply_to_message?.from?.id === BOT_USER_ID) {
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
                console.log(`Trigger '${triggerWord}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
            } else if (triggerWord && !promptForAI && triggerWord !== 'reply_to_bot') {
                // Gunakan 'Markdown' untuk pesan bantuan
                // Pastikan backtick benar: `contoh` bukan \`contoh\`
                let helpText = `Iya ${nameForBotGreeting}? Mau nanya apa nih? Contoh: \`${triggerWord.trim()} jelaskan soal black hole\``;
                await sendMessage(chatId, helpText, messageIdToReply, 'Markdown');
            } else if (!triggerWord) {
                console.log(`Ignoring non-trigger message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
            }
        } else {
            console.log(`Ignoring message from unsupported chat type: ${chatType}`);
        }

        // 3. Proses AI (Pemanggilan getGeminiResponse mengembalikan parseMode='Markdown' atau null)
        if (shouldProcessAI) {
            if (promptForAI.length > 3000) {
                // Gunakan 'Markdown' untuk pesan error
                await sendMessage(chatId, `Waduh ${nameForBotGreeting}, pertanyaannya panjang banget. Coba dipersingkat ya.`, messageIdToReply, 'Markdown');
            } else {
                try {
                    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }

                const aiResponseObject = await getGeminiResponse(chatId, promptForAI, nameForAIContext, enableGrounding);

                // Kirim balasan AI (parseMode diambil dari objek respons, akan jadi 'Markdown' atau null)
                await sendMessage(chatId, aiResponseObject.text, messageIdToReply, aiResponseObject.parseMode);
            }
        }

    } else if (update.message && update.message.chat) {
        console.log(`Ignoring non-text message update in chat ${update.message.chat.id}`);
    } else {
        console.log('Ignoring update that is not a message or lacks required fields.');
    }

    res.status(200).send('OK');
};