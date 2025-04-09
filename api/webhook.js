// api/webhook.js
const axios = require('axios');

// Ambil token & key dari environment variable
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Pastikan ini adalah systemInstruction yang sudah diubah (tanpa instruksi Markdown)
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_MODEL_NAME = "gemini-2.0-flash"; // Gunakan model yang sesuai (contoh: 1.5 flash)
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// --- Fungsi sendMessage (Tetap TANPA parse_mode) ---
async function sendMessage(chatId, text, replyToMessageId = null) {
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
            disable_web_page_preview: true // Penting agar URL sumber tidak memunculkan preview
        };
        if (replyToMessageId) { payload.reply_to_message_id = replyToMessageId; }
        // --- TIDAK ADA PENGATURAN parse_mode ---

        await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
        console.log(`Message sent to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Handle specific Telegram errors if needed (e.g., rate limits)
        if (error.response && error.response.status === 400 && error.response.data.description.includes("can't parse entities")) {
             console.error(`!!! Potential lingering Markdown issue detected despite parse_mode removal for message to ${chatId}. Raw text: ${text.substring(0, 100)}...`);
             // Fallback: Try sending with potentially problematic characters removed (simple example)
             const fallbackText = text.replace(/[*_`\[\]()]/g, ''); // Hapus karakter markdown dasar
             try {
                 console.log(`Attempting fallback send without potential Markdown chars to ${chatId}`);
                 const fallbackPayload = { ...payload, text: fallbackText.substring(0, MAX_LENGTH) }; // Gunakan payload asli tapi ganti teks
                 await axios.post(`${TELEGRAM_API}/sendMessage`, fallbackPayload);
             } catch (fallbackError) {
                console.error(`Fallback send also failed for ${chatId}:`, fallbackError.response ? JSON.stringify(fallbackError.response.data, null, 2) : fallbackError.message);
             }
        }
    }
}
// --- Akhir Fungsi sendMessage ---

// --- Riwayat & Nama Panggilan (Tetap Sama) ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 50;
// --- Akhir Simulasi Penyimpanan ---

// Fungsi baru untuk menghapus karakter Markdown umum
// Fungsi diperbarui untuk menghapus Markdown DAN menambah jarak antar item list
function stripMarkdown(text) {
    if (!text) return text;

    // 1. Preprocessing: Store original line info and remove markers/formatting
    const lines = text.split('\n');
    const lineInfo = lines.map((line, index) => ({
        original: line,
        wasListItem: /^\s*([*\-+]|\d+\.)\s+/.test(line),
        index: index // Simpan index asli untuk referensi
    }));

    let processedText = text;
    processedText = processedText.replace(/^\s*([*\-+]|\d+\.)\s+/gm, ''); // Remove list markers
    processedText = processedText.replace(/[*_`[\]]/g, '');             // Remove *, _, `, [, ]
    processedText = processedText.replace(/^\s*#+\s+/gm, '');          // Remove # headings
    processedText = processedText.replace(/^\s*([-*_]){3,}\s*$/gm, ''); // Remove horizontal rules

    const processedLines = processedText.split('\n');
    // Filter baris kosong yang mungkin muncul setelah replace, tapi pertahankan struktur relatif
    const nonEmptyLines = processedLines
        .map((line, index) => ({ text: line, originalIndex: index })) // Simpan index asli setelah replace
        .filter(item => item.text.trim() !== ''); // Hanya ambil baris yang tidak kosong

    let resultText = "";
    let previousLineInfo = null; // Lacak info baris sebelumnya

    // 2. Iterate through non-empty lines and build result with correct spacing
    for (let i = 0; i < nonEmptyLines.length; i++) {
        const currentItem = nonEmptyLines[i];
        const currentLineContent = currentItem.text;
        // Dapatkan info asli (termasuk wasListItem) berdasarkan originalIndex
        const currentOriginalInfo = lineInfo.find(info => info.index === currentItem.originalIndex);
        const currentWasList = currentOriginalInfo?.wasListItem ?? false;

        let needsDoubleNewlineBefore = false;

        if (i > 0 && previousLineInfo) { // Hanya cek jika ada baris sebelumnya
            const previousWasList = previousLineInfo.wasListItem;

            // Kondisi 1: Transisi dari Intro ke List Pertama
            // Jika baris sebelumnya BUKAN list, TAPI baris ini ADALAH list
            if (!previousWasList && currentWasList) {
                needsDoubleNewlineBefore = true;
            }
            // Kondisi 2: Pemisah Antar List Item
            // Jika baris sebelumnya ADALAH list, DAN baris ini JUGA ADALAH list
            else if (previousWasList && currentWasList) {
                needsDoubleNewlineBefore = true;
            }
            // Kondisi 3: Transisi dari List Terakhir ke Penutup
            // Jika baris sebelumnya ADALAH list, TAPI baris ini BUKAN list
            else if (previousWasList && !currentWasList) {
                 needsDoubleNewlineBefore = true;
            }
        }

        // Tambahkan separator SEBELUM baris saat ini (kecuali baris pertama)
        if (i > 0) {
            if (needsDoubleNewlineBefore) {
                 // Pastikan tidak menambah \n\n jika resultText sudah berakhir \n\n
                 if (!resultText.endsWith('\n\n')) {
                    resultText += '\n\n';
                 } else {
                    // Jika sudah \n\n, mungkin cukup \n? Atau tidak sama sekali?
                    // Coba tidak tambah apa-apa jika sudah \n\n
                 }
            } else {
                 // Jika tidak butuh double, tambahkan single newline standard
                  // Pastikan tidak menambah \n jika resultText sudah berakhir \n
                 if (!resultText.endsWith('\n')) {
                    resultText += '\n';
                 }
            }
        }

        // Tambahkan konten baris saat ini
        resultText += currentLineContent;

        // Update info baris sebelumnya untuk iterasi berikutnya
        previousLineInfo = { wasListItem: currentWasList }; // Simpan status list item terakhir
    }

    // 3. Final Cleanup (opsional, tapi bisa membantu)
    resultText = resultText.trim();
    // resultText = resultText.replace(/\n{3,}/g, '\n\n'); // Mungkin tidak perlu jika logika di atas benar

    return resultText;
}

// --- Fungsi Panggil Gemini (Format sumber sudah plain text, pastikan AI tidak menambah Markdown) ---
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
        // Penting: Pastikan systemInstructionText benar-benar *tidak* menyuruh Gemini pakai Markdown.
        // Contoh instruksi tambahan di systemInstructionText: "Berikan jawaban hanya dalam format teks biasa tanpa markup atau Markdown."
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
    }
    // Selalu tambahkan prompt pengguna
    history.push({ role: "user", parts: [{ text: newUserPrompt }] });

    // Logic pemotongan history (Sama)
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
    console.log(`Calling Gemini API for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt}". Grounding: ${enableGrounding}`);

    // Request Body
    const requestBody = {
        systemInstruction: { parts: history.filter(h => h.role === 'system').flatMap(h => h.parts) },
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 1.0, // Mungkin bisa diturunkan sedikit (misal 0.8) jika ingin lebih faktual
            topP: 0.9,
            // response_mime_type: "text/plain" // Jika model mendukung, ini cara eksplisit minta plain text
        },
        // safetySettings: [ // Opsional: Sesuaikan safety settings
        //     { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        //     // ... other categories
        // ]
    };

    if (enableGrounding) {
        // Gunakan 'tools' dengan 'google_search' (atau 'googleSearchRetrieval' tergantung API version/model)
        requestBody.tools = [{
            'google_search': {} // Ganti 'googleSearchRetrieval' menjadi 'google_search'
                                 // Biasanya cukup objek kosong {} sudah cukup
        }];
        console.log("Grounding enabled (google_search/googleSearchRetrieval) for this request.");
    }

    try {
        const response = await axios.post(GEMINI_API_URL, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 90000 // Naikkan timeout jika grounding sering timeout
        });

        const candidate = response.data?.candidates?.[0];
        let aiResponseText = '';

        if (!candidate) {
             // Handle kasus tidak ada kandidat sama sekali
             console.error("Gemini response missing candidates.", JSON.stringify(response.data, null, 2));
             chatHistories[chatId] = historyBeforeResponse; // Rollback
             return { text: `Waduh ${userName}, AI-nya nggak ngasih respon nih kali ini. Coba lagi ya.`, parseMode: null };
        }

        // Penanganan function call (Jika ada, coba ambil teks juga)
        if (candidate.content?.parts?.some(part => part.functionCall)) {
            console.warn("Received functionCall, grounding results might be separate or missing text.");
            // Coba cari bagian teks jika ada di antara function calls/results
             aiResponseText = candidate.content.parts?.find(part => part.text)?.text || '';
             if (!aiResponseText) {
                 console.warn("No direct text part found alongside functionCall.");
                 // Jika tidak ada teks sama sekali, mungkin beri pesan placeholder
                 aiResponseText = "(Hasil pencarian web diproses, tapi tidak ada teks ringkasan)";
             }
        } else {
            aiResponseText = candidate.content?.parts?.[0]?.text;
        }

        // Ambil metadata grounding (citationMetadata)
        const groundingAttributions = candidate.citationMetadata?.citationSources;

        // supaya clear
        if (aiResponseText) {
            console.log("Original AI text received:", aiResponseText.substring(0,100) + "..."); // Log sebelum strip
            // Panggil fungsi pembersih SETELAH mendapatkan teks dari AI
            aiResponseText = stripMarkdown(aiResponseText);
            console.log("AI text after stripping Markdown:", aiResponseText.substring(0,100) + "..."); // Log setelah strip
        }

        if (aiResponseText || (enableGrounding && groundingAttributions && groundingAttributions.length > 0)) {
            console.log("Gemini response text received (or grounding results found).");
             // Jika aiResponseText kosong tapi ada grounding, beri placeholder
             if (!aiResponseText && groundingAttributions && groundingAttributions.length > 0) {
                 aiResponseText = "(Berikut sumber yang ditemukan)";
             } else if (!aiResponseText) {
                 // Kasus tidak ada teks dan tidak ada grounding (seharusnya tidak terjadi jika candidate ada)
                 console.error("Gemini response format unexpected: No text and no grounding.", JSON.stringify(response.data, null, 2));
                 chatHistories[chatId] = historyBeforeResponse; // Rollback
                 return { text: "Waduh, AI-nya lagi diem nih, nggak ngasih jawaban.", parseMode: null };
             }

            // Tambahkan ke history (hanya model part)
            history.push({ role: "model", parts: [{ text: aiResponseText }] }); // Hanya simpan teks utama di history
            chatHistories[chatId] = history; // Update simulasi

            let finalResponseText = aiResponseText;
            // --- SELALU SET parseMode KE null ---
            let parseMode = null;

            // --- PROSES GROUNDING ATTRIBUTIONS (Format plain text, SUDAH BENAR) ---
            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", groundingAttributions.length);
                finalResponseText += "\n\nSumber:"; // Judul bagian (plain text)

                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        // Coba ambil judul, fallback ke URI yang dibersihkan sedikit (opsional)
                        title: source.displayName || source.uri?.split('/').pop() || source.uri // Judul atau bagian akhir URI
                    }))
                    .filter(source => source.uri) // Pastikan ada URI
                    // Filter unik berdasarkan URI
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri));

                if (sources.length > 0) {
                    sources.forEach((source, index) => {
                        // Tampilkan sebagai daftar teks biasa, tanpa markdown
                        finalResponseText += `\n${index + 1}. ${source.title || source.uri}`; // Tampilkan judul atau URI
                        // Jangan tambahkan URI secara eksplisit jika sudah ada di title
                        if (source.title && source.title !== source.uri) {
                             // finalResponseText += ` (${source.uri})`; // Uncomment jika ingin tetap menampilkan URI di ()
                        }
                    });
                    finalResponseText += "\n"; // Spasi setelah daftar
                } else {
                    finalResponseText += " (Tidak dapat memformat sumber)";
                    console.warn("Could not format any valid sources from grounding attributions.");
                }
            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found in response.");
                // Opsional: Beri tahu pengguna jika grounding aktif tapi tidak ada sumber
                // finalResponseText += "\n(Info dicari di web, tapi tidak ada sumber spesifik ditemukan)";
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
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI-nya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response && error.response.data && error.response.data.error) {
            // Pesan error dari API (plain text)
            errorMsg = `Error dari AI (${error.response.data.error.code || error.response.status}): ${error.response.data.error.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI-nya lagi ada masalah internal nih. Coba beberapa saat lagi.`;
        }
        return { text: errorMsg, parseMode: null }; // Selalu parseMode null
    }
}
// --- Akhir Fungsi Gemini ---

// --- Handler Utama Vercel (DIUBAH: Logika trigger grounding) ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed' }); }
    // Periksa apakah req.body ada dan merupakan objek sebelum melanjutkan
    if (!req.body || typeof req.body !== 'object') {
        console.log('Received invalid or empty request body.');
        return res.status(200).send('OK - Invalid body'); // Kirim OK tapi log sbg invalid
    }


    console.log('Received update:', JSON.stringify(req.body, null, 2));
    const update = req.body;

    // Pastikan update.message dan struktur dasarnya ada
    if (update.message && update.message.chat && update.message.from) {
        const chatId = update.message.chat.id;
        const message = update.message;
        const messageText = (message.text || "").trim(); // Pastikan text ada, jika tidak string kosong
        const chatType = message.chat.type;
        const messageId = message.message_id;
        const userId = message.from.id;
        const username = message.from.username;
        const firstName = message.from.first_name;

        // Jangan proses jika messageText kosong setelah trim
        if (!messageText) {
             console.log(`Ignoring message ${messageId} in chat ${chatId} because it has no text content.`);
             return res.status(200).send('OK');
        }

        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

        let shouldProcessAI = false;
        let promptForAI = "";
        let messageIdToReply = messageId;
        let enableGrounding = false;
        let triggerWordUsed = null; // Untuk menyimpan trigger yang digunakan

        const lowerCaseText = messageText.toLowerCase();
        const BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        // 1. Handle /clear command (Tetap di awal)
        if (lowerCaseText === '/clear') {
            if (chatHistories[chatId]) {
                delete chatHistories[chatId];
                await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan!`, messageIdToReply);
                console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus.`, messageIdToReply);
            }
            return res.status(200).send('OK'); // Selesai setelah /clear
        }

        // 2. Tentukan pemrosesan AI dan Grounding
        // --- AWAL: Cek Trigger Grounding ---
        const groundingTriggers = ['/info ', 'inpo ', 'kabar ', '/po ']; // Pastikan ada spasi di akhir
        for (const trigger of groundingTriggers) {
            if (lowerCaseText.startsWith(trigger)) {
                triggerWordUsed = trigger.trim(); // Simpan trigger tanpa spasi
                promptForAI = messageText.substring(trigger.length).trim();
                if (promptForAI) {
                    shouldProcessAI = true;
                    enableGrounding = true; // Aktifkan Grounding
                    console.log(`Processing message ${messageId} WITH grounding (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId})`);
                } else {
                    // Pesan bantuan jika prompt kosong (plain text)
                    await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari ${triggerWordUsed} apa? Contoh: ${triggerWordUsed} berita terkini tentang AI`, messageIdToReply);
                    shouldProcessAI = false; // Jangan proses AI jika prompt kosong
                }
                break; // Hentikan loop jika trigger grounding ditemukan
            }
        }
        // --- AKHIR: Cek Trigger Grounding ---

        // 3. Jika BUKAN trigger grounding, cek kondisi lain (Private, Group Trigger, Reply)
        if (!triggerWordUsed) { // Hanya jalan jika tidak ada trigger grounding yang cocok di atas
            enableGrounding = false; // Grounding tidak aktif untuk kasus di bawah ini

            if (chatType === 'private') {
                shouldProcessAI = true;
                promptForAI = messageText; // Gunakan seluruh teks pesan
                triggerWordUsed = 'private_chat'; // Tandai sebagai private chat
                console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
            } else if (chatType === 'group' || chatType === 'supergroup') {
                // --- Cek Trigger Chat Biasa ---
                const chatTriggers = ['/chat ', 'lele ', 'le ', 'tanya ']; // Spasi penting
                for (const trigger of chatTriggers) {
                    if (lowerCaseText.startsWith(trigger)) {
                        triggerWordUsed = trigger.trim();
                        promptForAI = messageText.substring(trigger.length).trim();
                        break;
                    }
                }

                // --- Cek Trigger Reply ke Bot ---
                // Hanya jika belum ada trigger chat biasa DAN ini adalah balasan ke bot
                if (!triggerWordUsed && BOT_USER_ID && message.reply_to_message?.from?.id === BOT_USER_ID) {
                    triggerWordUsed = 'reply_to_bot';
                    promptForAI = messageText; // Gunakan teks balasan sebagai prompt
                }

                // --- Tambah Konteks jika Reply ke Pesan Lain (berlaku untuk trigger chat & reply_to_bot) ---
                if (triggerWordUsed && message.reply_to_message && message.reply_to_message.text) {
                    const repliedText = message.reply_to_message.text;
                    let originalSenderName = 'seseorang';
                     const repliedFrom = message.reply_to_message.from;
                     if (repliedFrom) {
                         // Cek nickname dulu
                         const repliedUsername = repliedFrom.username ? repliedFrom.username.toLowerCase() : null;
                         const repliedNickname = repliedUsername ? userNicknames[repliedUsername] : null;
                        originalSenderName = repliedNickname || repliedFrom.first_name || (repliedFrom.username ? `@${repliedFrom.username}` : `User ${repliedFrom.id}`);
                     }

                    // Format prompt dengan konteks (plain text)
                    // Pastikan promptForAI (pertanyaan/pernyataan user) sudah ada
                    const basePrompt = (triggerWordUsed === 'reply_to_bot') ? messageText : promptForAI; // Ambil prompt yang sesuai
                    promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya berikut: "${basePrompt}"`;
                    console.log(`Added context from replied message ${message.reply_to_message.message_id}`);
                    messageIdToReply = message.reply_to_message.message_id; // Balas ke pesan asli yang direply user
                }


                // --- Tentukan apakah akan proses AI berdasarkan trigger chat/reply ---
                if (triggerWordUsed && promptForAI) {
                    shouldProcessAI = true;
                    console.log(`Trigger '${triggerWordUsed}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
                } else if (triggerWordUsed && !promptForAI && triggerWordUsed !== 'reply_to_bot') {
                    // Pesan bantuan jika prompt kosong (plain text)
                    let helpText = `Iya ${nameForBotGreeting}? Mau nanya apa nih pakai ${triggerWordUsed}? Contoh: ${triggerWordUsed} jelaskan soal black hole`;
                    await sendMessage(chatId, helpText, messageIdToReply);
                    shouldProcessAI = false;
                } else if (!triggerWordUsed) {
                    console.log(`Ignoring non-trigger message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
                    shouldProcessAI = false;
                }
            } else {
                console.log(`Ignoring message from unsupported chat type: ${chatType}`);
                shouldProcessAI = false;
            }
        }

        // 4. Proses AI jika diperlukan (shouldProcessAI = true)
        if (shouldProcessAI) {
            if (promptForAI.length > 5000) { // Batas panjang prompt (sesuaikan)
                await sendMessage(chatId, `Waduh ${nameForBotGreeting}, pertanyaannya panjang banget nih (> 5000 karakter). Coba dipersingkat ya.`, messageIdToReply);
            } else {
                try {
                    // Kirim 'typing' action
                    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }

                // Panggil Gemini (enableGrounding sudah diatur sebelumnya)
                const aiResponseObject = await getGeminiResponse(chatId, promptForAI, nameForAIContext, enableGrounding);

                // Kirim balasan AI (fungsi sendMessage sudah TIDAK pakai parse_mode)
                await sendMessage(chatId, aiResponseObject.text, messageIdToReply); // Balas ke pesan trigger atau pesan yang direply user
            }
        }

    } else if (update.message && update.message.chat) {
        // Handle pesan non-teks atau pesan tanpa pengirim (opsional)
        const chatId = update.message.chat.id;
        console.log(`Ignoring non-text or incomplete message update in chat ${chatId || 'unknown'}`);
    } else {
        console.log('Ignoring update that is not a message or lacks required fields.');
    }

    res.status(200).send('OK');
};