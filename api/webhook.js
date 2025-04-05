// api/webhook.js
const axios = require('axios');

// Ambil token & key dari environment variable
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
// --- Gunakan model yang support Gemini 1.5 Flash jika tersedia ---
// const GEMINI_MODEL_NAME = "gemini-1.5-flash-latest"; // Coba ini jika tersedia
const GEMINI_MODEL_NAME = "models/gemini-2.0-flash"; // Atau Pro jika Flash belum ada/bermasalah
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`; // Updated URL Prefix

// --- Fungsi sendMessage (Tetap Sama, tapi perhatikan retry logic) ---
async function sendMessage(chatId, text, replyToMessageId = null, parse_mode = null) {
    if (!BOT_TOKEN) { /*...*/ return; }
    try {
        const MAX_LENGTH = 4096;
        let messageToSend = text;
        // --- PERBAIKAN POTONG PESAN MARKDOWN ---
        // Memotong pesan Markdown perlu hati-hati agar tidak memotong di tengah format
        // Pendekatan sederhana: Potong lebih awal dan pastikan tidak ada karakter format terbuka di akhir
        if (text.length > MAX_LENGTH) {
            messageToSend = text.substring(0, MAX_LENGTH - 50); // Potong lebih awal
            // Hapus karakter format potensial di akhir
            messageToSend = messageToSend.replace(/[_*[\]()~`>#+\-=|{}.!]$/, '');
            messageToSend += "\n... (dipotong)";
            console.warn(`Message to ${chatId} was truncated due to length limit.`);
        }
        // --- Akhir Perbaikan Potong Pesan ---

        const payload = {
            chat_id: chatId,
            text: messageToSend,
            disable_web_page_preview: true
        };
        if (replyToMessageId) { payload.reply_to_message_id = replyToMessageId; }
        // --- Set parse_mode JIKA ada ---
        if (parse_mode) {
            // --- PENTING: Gunakan MarkdownV2 untuk Quora Style ---
            // MarkdownV2 lebih ketat tapi lebih kaya fitur daripada HTML atau Markdown lama
            // Pastikan system prompt mengarahkan AI untuk output MarkdownV2
            payload.parse_mode = 'MarkdownV2';
        }

        await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
        console.log(`Message sent to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : '') + (payload.parse_mode ? ` with parse_mode=${payload.parse_mode}` : ''));
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // --- Retry logic jika parse error ---
        if (parse_mode && error.response && error.response.data && error.response.data.description && error.response.data.description.toLowerCase().includes('parse error')) {
            console.warn(`Retrying message to ${chatId} without parse_mode due to formatting error. Original error: ${error.response.data.description}`);
            // Kirim ulang tanpa parse_mode
            await sendMessage(chatId, text, replyToMessageId, null); // Kirim teks asli, BUKAN messageToSend yg mungkin terpotong salah
        } else if (error.response && error.response.data && error.response.data.error_code === 400) {
            // Catchall untuk bad request lain yg mungkin krn format
            console.warn(`Retrying message to ${chatId} without parse_mode due to generic bad request (maybe formatting). Original error: ${error.response.data.description}`);
            await sendMessage(chatId, text, replyToMessageId, null);
        }
    }
}
// --- Akhir Fungsi sendMessage ---

// --- Riwayat & Nama Panggilan (Tetap Sama) ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 100; // Atau sesuaikan kebutuhan

// --- Akhir Simulasi Penyimpanan ---

// --- Fungsi Panggil Gemini (DIMODIFIKASI: Selalu set parseMode, handle grounding link) ---
async function getGeminiResponse(chatId, newUserPrompt, userName = 'mas', enableGrounding = false) {
    if (!GEMINI_API_KEY) { /*...*/ return { text: "Maaf, konfigurasi AI belum diatur.", parseMode: null }; }

    let history = chatHistories[chatId] || [];
    // --- Konteks nama pengguna ditambahkan di awal history saja jika belum ada ---
    if (history.length === 0) {
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}. Sapa atau gunakan nama ini sesekali jika relevan.` }] });
    }
    // Tambahkan prompt pengguna baru
    history.push({ role: "user", parts: [{ text: newUserPrompt }] });


    // Logic pemotongan history (Pastikan system instruction inti tidak terpotong)
    // ... (logika pemotongan history sebaiknya lebih canggih, tapi kita keep simple dulu) ...
    if (history.length > MAX_HISTORY_LENGTH) {
        console.warn(`History for chat ${chatId} exceeding ${MAX_HISTORY_LENGTH}, trimming...`);
        // Buang bagian tengah (setelah system prompt jika ada, sebelum beberapa chat terakhir)
        const systemPromptsCount = history.filter(h => h.role === 'system').length;
        const conversationTurns = (history.length - systemPromptsCount) / 2; // asumsi user-model pair
        const turnsToKeep = 10; // Jaga 10 percakapan terakhir
        if (conversationTurns > turnsToKeep) {
            const itemsToRemove = (Math.floor(conversationTurns) - turnsToKeep) * 2;
            history.splice(systemPromptsCount, itemsToRemove); // Hapus dari setelah system prompt
            console.log(`Trimmed ${itemsToRemove} items from history for chat ${chatId}`);
        }
    }

    const historyBeforeResponse = [...history]; // Salin untuk rollback

    console.log(`Calling Gemini API for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt}". Grounding: ${enableGrounding}`);

    // ++ BUAT REQUEST BODY DASAR ++
    const requestBody = {
        // ** Pindahkan System Instruction dari history ke field khusus **
        // Ini cara yang lebih direkomendasikan untuk model Gemini terbaru
        systemInstruction: { parts: [{ "text": systemInstructionText }] },
        // Contents sekarang hanya berisi riwayat user/model
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 0.5, // Naikkan sedikit untuk gaya Quora yg lebih variatif
            topP: 0.9, // Bisa juga sedikit dinaikkan
            // maxOutputTokens: 1024 // Batasi output jika perlu
        },
        // Safety Settings (opsional tapi bagus)
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
        ]

    };

    // ++ TAMBAHKAN TOOLS HANYA JIKA GROUNDING DIAKTIFKAN ++
    if (enableGrounding) {
        requestBody.tools = [{
            // --- Gunakan Google Search Tool yang baru ---
            'googleSearchRetrieval': {}
        }];
        console.log("Grounding enabled (googleSearchRetrieval) for this request.");
    }

    try {
        const response = await axios.post(GEMINI_API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 60000 // Naikkan timeout karena grounding bisa lama
        });

        // --- PERIKSA RESPON DARI GEMINI TOOL CALL ---
        const candidate = response.data?.candidates?.[0];
        let aiResponseText = '';
        let functionCalls = null;

        // Cek apakah ada function call (untuk grounding)
        if (candidate?.content?.parts?.[0]?.functionCall) {
            // Gemini meminta untuk memanggil tool (Google Search)
            // Saat ini API kita belum handle ini secara eksplisit (langsung return hasil search)
            // Untuk grounding `googleSearchRetrieval`, Gemini seharusnya langsung menyertakan hasilnya
            console.warn("Received functionCall, expected grounding results directly. Checking response structure.");
            // Coba cari teks di bagian lain jika ada
            aiResponseText = candidate?.content?.parts?.find(part => part.text)?.text || '';
        } else {
            // Respon teks biasa
            aiResponseText = candidate?.content?.parts?.[0]?.text;
        }


        // --- AMBIL METADATA GROUNDING (JIKA ADA) ---
        // Format metadata mungkin sedikit berbeda dengan `googleSearchRetrieval`
        const groundingAttributions = candidate?.citationMetadata?.citationSources; // Coba path ini untuk model baru

        if (aiResponseText) {
            console.log("Gemini response text received.");
            // Tambahkan respons AI ke history *setelah* dipastikan sukses
            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history; // Update simulasi

            let finalResponseText = aiResponseText;
            // ++ SELALU COBA GUNAKAN MARKDOWN V2 ++
            let parseMode = 'MarkdownV2'; // Default ke MarkdownV2

            // ++ PROSES GROUNDING ATTRIBUTIONS JIKA ADA ++
            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", JSON.stringify(groundingAttributions, null, 2));
                // Format sumber menggunakan MarkdownV2
                finalResponseText += "\n\n*Sumber:*"; // Gunakan italic dan new line
                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        // Judul mungkin tidak selalu ada, gunakan domain sebagai fallback
                        title: source.displayName || source.uri?.split('/')[2]?.split('?')[0] || 'Sumber tidak dikenal'
                    }))
                    .filter(source => source.uri) // Pastikan ada URI
                    // Unik berdasarkan URI
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri));

                if (sources.length > 0) {
                    sources.forEach((source, index) => {
                        // Escape karakter khusus MarkdownV2 di judul dan URI
                        const escapedTitle = escapeMarkdownV2(source.title);
                        const escapedUri = escapeMarkdownV2(source.uri); // URI juga perlu di-escape
                        finalResponseText += `\n${index + 1}\\. [${escapedTitle}](${escapedUri})`; // Format link MarkdownV2: [text](url)
                    });
                    finalResponseText += "\n"; // Tambah spasi setelah daftar sumber
                } else {
                    finalResponseText += " (Tidak dapat memformat sumber)"; // Fallback jika gagal map
                    console.warn("Could not format any valid sources from grounding attributions.");
                }
                // Kueri pencarian terkait mungkin tidak ada di format baru, jadi kita skip
            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found in response.");
            }

            // Kembalikan teks dan parse mode
            return { text: finalResponseText.trim(), parseMode: parseMode };

        } else {
            console.error("Gemini response format unexpected or empty text.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse; // Rollback history
            return { text: "Waduh, AI-nya lagi bingung nih, responsnya kosong.", parseMode: null };
        }

    } catch (error) {
        // Logic error handling (sama, tapi pastikan rollback history)
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        chatHistories[chatId] = historyBeforeResponse; // Rollback history
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI-nya. Coba lagi nanti ya.`;
        // ... (pesan error spesifik lainnya tetap sama) ...
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI-nya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response && error.response.data && error.response.data.error) { errorMsg = `Error dari AI (${error.response.data.error.code || error.response.status}): ${escapeMarkdownV2(error.response.data.error.message || 'Gagal memproses')}. Coba cek lagi ${userName}`; } // Escape pesan error juga
        return { text: errorMsg, parseMode: null }; // Error message sebaiknya tidak pakai parse mode
    }
}
// --- Akhir Fungsi Gemini ---

// --- Fungsi helper untuk escape MarkdownV2 ---
function escapeMarkdownV2(text) {
    if (!text) return '';
    // Karakter yang perlu di-escape dalam MarkdownV2
    const charsToEscape = '_*[]()~`>#+-=|{}.!';
    return text.replace(new RegExp(`([${charsToEscape.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}])`, 'g'), '\\$1');
}

// --- Handler Utama Vercel (Pemanggilan sendMessage sudah benar) ---
module.exports = async (req, res) => {
    // ... (Bagian awal handler tetap sama: cek method, body, ambil update) ...
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

        // --- Dapatkan nama panggilan (Sama) ---
        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

        let shouldProcessAI = false;
        let promptForAI = "";
        let isClearCommand = false;
        let messageIdToReply = messageId;
        let enableGrounding = false;

        let BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        // 1. Handle /clear command (Sama)
        if (messageText.toLowerCase() === '/clear') {
            isClearCommand = true;
            // Hapus riwayat
            if (chatHistories[chatId]) {
                delete chatHistories[chatId];
                await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan\\!`, messageIdToReply, 'MarkdownV2'); // Escape tanda seru
                console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus\\.`, messageIdToReply, 'MarkdownV2'); // Escape titik
            }
            return res.status(200).send('OK');
        }


        // 2. Tentukan apakah perlu memproses AI dan apakah grounding aktif (Logika trigger SAMA)
        const lowerCaseText = messageText.toLowerCase();

        // ++ Cek /info dulu ++
        if (lowerCaseText.startsWith('/info ')) {
            promptForAI = messageText.substring(6).trim();
            if (promptForAI) {
                shouldProcessAI = true;
                enableGrounding = true;
                console.log(`Processing message ${messageId} WITH grounding from ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari info apa pakai /info? Contoh: \`/info berita terkini tentang AI\``, messageIdToReply, 'MarkdownV2');
            }
        }
        // ++ Jika bukan /info, cek trigger lain (private, /ai, sofia, sof, reply) ++
        else if (chatType === 'private') {
            shouldProcessAI = true;
            promptForAI = messageText;
            enableGrounding = false; // Grounding nonaktif untuk chat biasa
            console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
        } else if (chatType === 'group' || chatType === 'supergroup') {
            // ... (logika trigger /ai, sofia, sof, reply sama persis) ...
            let triggerWord = null;
            if (lowerCaseText.startsWith('/ai ')) {
                triggerWord = '/ai ';
                promptForAI = messageText.substring(4).trim();
            } else if (lowerCaseText.startsWith('sofia ')) {
                triggerWord = 'sofia ';
                promptForAI = messageText.substring(6).trim();
            } else if (lowerCaseText.startsWith('sof ')) {
                triggerWord = 'sof ';
                promptForAI = messageText.substring(4).trim();
            } else if (BOT_USER_ID && message.reply_to_message?.from?.id === BOT_USER_ID) {
                triggerWord = 'reply_to_bot';
                promptForAI = messageText; // Ambil seluruh teks balasan
            }

            // Jika trigger reply, tambahkan konteks pesan yang dibalas
            if (triggerWord && message.reply_to_message && message.reply_to_message.text) {
                const repliedText = message.reply_to_message.text;
                // Ambil nama pengirim asli jika bisa
                const originalSenderName = message.reply_to_message.from.first_name || (message.reply_to_message.from.username ? `@${message.reply_to_message.from.username}` : `User ${message.reply_to_message.from.id}`);
                // Format prompt baru dengan konteks balasan
                promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya berikut: "${promptForAI}"`;
                console.log(`Added context from replied message ${message.reply_to_message.message_id}`);
            }


            if (triggerWord && promptForAI) {
                shouldProcessAI = true;
                enableGrounding = false; // Grounding tidak aktif untuk trigger biasa
                console.log(`Trigger '${triggerWord}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
            } else if (triggerWord && !promptForAI && triggerWord !== 'reply_to_bot') {
                let helpText = `Iya ${nameForBotGreeting}? Mau nanya apa nih? Contoh: \`${triggerWord}jelaskan soal black hole\``; // Escape trigger
                await sendMessage(chatId, helpText, messageIdToReply, 'MarkdownV2');
            } else if (!triggerWord) {
                console.log(`Ignoring non-trigger message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
            }
        } else {
            console.log(`Ignoring message from unsupported chat type: ${chatType}`);
        }

        // 3. Proses AI jika flag `shouldProcessAI` aktif (Pemanggilan getGeminiResponse SAMA)
        if (shouldProcessAI) {
            // Batas panjang prompt (Sama)
            if (promptForAI.length > 3000) { // Kurangi sedikit batasnya
                await sendMessage(chatId, `Waduh ${nameForBotGreeting}, pertanyaannya panjang banget\\. Coba dipersingkat ya\\.`, messageIdToReply, 'MarkdownV2');
            } else {
                // Kirim typing action (Sama)
                try {
                    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }

                // Panggil Gemini (Sama, tapi internalnya sudah dimodif)
                const aiResponseObject = await getGeminiResponse(chatId, promptForAI, nameForAIContext, enableGrounding);

                // Kirim balasan AI (Sama, parameter parseMode sudah otomatis dari aiResponseObject)
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