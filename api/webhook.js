// api/webhook.js
const axios = require('axios');

// Ambil token & key dari environment variable
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
// --- >>> Ganti ke Model yang Mendukung Vision <<< ---
// Pilih salah satu: gemini-1.5-pro-latest, gemini-1.5-flash-latest
const GEMINI_VISION_MODEL_NAME = "gemini-2.0-flash"; // Model untuk Vision
const GEMINI_TEXT_MODEL_NAME = "gemini-2.0-flash"; // Model untuk Teks Biasa (bisa sama atau beda)
// Gunakan nama model yang sesuai di URL
const GEMINI_API_URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/`; // Base URL

// --- Fungsi sendMessage (Tetap Sama) ---
async function sendMessage(chatId, text, replyToMessageId = null) {
    // ... (Kode sendMessage tetap sama seperti sebelumnya) ...
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

        await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
        console.log(`Message sent to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));
    } catch (error) {
        console.error(`Error sending message to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Fallback jika ada error parsing Markdown (meskipun sudah dihapus)
        if (error.response && error.response.status === 400 && error.response.data.description.includes("can't parse entities")) {
             console.error(`!!! Potential lingering Markdown issue detected despite parse_mode removal for message to ${chatId}. Raw text: ${text.substring(0, 100)}...`);
             const fallbackText = text.replace(/[*_`\[\]()]/g, ''); // Hapus karakter markdown dasar
             try {
                 console.log(`Attempting fallback send without potential Markdown chars to ${chatId}`);
                 const fallbackPayload = { ...payload, text: fallbackText.substring(0, MAX_LENGTH) };
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
const MAX_HISTORY_LENGTH = 50; // Kurangi jika ada gambar agar tidak terlalu berat
// --- Akhir Riwayat ---

// --- Fungsi stripMarkdown (Gunakan versi yang MENGGABUNGKAN list) ---
function stripMarkdown(text) {
    // ... (Salin kode fungsi stripMarkdown yang MENGGABUNGKAN list dari jawaban sebelumnya di sini) ...
    if (!text) return text;

    // --- 1. Preprocessing: Identify list items BEFORE stripping markers ---
    const originalLines = text.split('\n');
    const lineInfo = originalLines.map(line => ({
        original: line,
        wasListItem: /^\s*([*\-+]|\d+\.)\s/.test(line.trimStart()),
        textWithoutMarker: line.replace(/^\s*([*\-+]|\d+\.)\s*/, '').trim()
    }));

    // --- 2. Basic Stripping ---
    let baseStrippedText = text;
    baseStrippedText = baseStrippedText.replace(/[*_`]/g, '');
    baseStrippedText = baseStrippedText.replace(/[\[\]]/g, '');
    baseStrippedText = baseStrippedText.replace(/^\s*#+\s+/gm, '');
    baseStrippedText = baseStrippedText.replace(/^\s*([-*_]){3,}\s*$/gm, '');

    const baseStrippedLines = baseStrippedText.split('\n');
    let resultText = "";
    let currentListItemsTexts = []; // Buffer untuk teks item list saat ini

    // --- 3. Line-by-Line Processing for List Collapsing ---
    for (let i = 0; i < lineInfo.length; i++) {
        const info = lineInfo[i];
        const currentLineBaseStripped = (baseStrippedLines[i] || "").trim();

        if (info.wasListItem && info.textWithoutMarker) {
             let textToAdd = info.textWithoutMarker;
             textToAdd = textToAdd.replace(/[*_`]/g, '');
             if (textToAdd) {
                 currentListItemsTexts.push(textToAdd);
             }
        } else {
            // Process buffered list items first
            if (currentListItemsTexts.length > 0) {
                let joinedList = "";
                if (currentListItemsTexts.length === 1) { joinedList = currentListItemsTexts[0]; }
                else if (currentListItemsTexts.length === 2) { joinedList = currentListItemsTexts.join(" dan "); }
                else { joinedList = currentListItemsTexts.slice(0, -1).join(", ") + " dan " + currentListItemsTexts.slice(-1); }

                if (resultText.length > 0 && !resultText.endsWith('\n\n')) { resultText = resultText.trimEnd() + '\n\n'; }
                resultText += joinedList;
                currentListItemsTexts = []; // Clear buffer
            }

            // Add the current non-list line
            const lineToAdd = currentLineBaseStripped.replace(/^\s*([*\-+]|\d+\.)\s*/, '').trim();
            if (!info.wasListItem && lineToAdd) {
                 if (resultText.length > 0 && !resultText.endsWith('\n\n')) { resultText = resultText.trimEnd() + '\n\n'; }
                 resultText += lineToAdd;
            } else if (!info.wasListItem && resultText.length > 0 && !resultText.endsWith('\n\n') && (!baseStrippedLines[i+1] || /^\s*$/.test(baseStrippedLines[i+1]))) {
                 // Add blank line if current line is empty non-list and previous wasn't ended with blank line
                 // And next line is also likely empty or end of text
                  if (!/^\s*$/.test(currentLineBaseStripped)) { // avoid adding \n\n for consecutive empty lines
                    resultText = resultText.trimEnd() + '\n\n';
                  }
            }
        }
    }

    // --- 4. Process remaining list items ---
    if (currentListItemsTexts.length > 0) {
        let joinedList = "";
        if (currentListItemsTexts.length === 1) { joinedList = currentListItemsTexts[0]; }
        else if (currentListItemsTexts.length === 2) { joinedList = currentListItemsTexts.join(" dan "); }
        else { joinedList = currentListItemsTexts.slice(0, -1).join(", ") + " dan " + currentListItemsTexts.slice(-1); }
        if (resultText.length > 0 && !resultText.endsWith('\n\n')) { resultText = resultText.trimEnd() + '\n\n'; }
        resultText += joinedList;
    }

    // --- 5. Final Cleanup ---
    resultText = resultText.replace(/ +/g, ' ');
    resultText = resultText.replace(/\n{3,}/g, '\n\n');
    return resultText.trim();
}
// --- Akhir Fungsi stripMarkdown ---


// --- >>> Fungsi Panggil Gemini DIMODIFIKASI <<< ---
async function getGeminiResponse(chatId, newUserPrompt, userName = 'mas', enableGrounding = false, imageBase64 = null, imageMimeType = null) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set.");
        return { text: "Maaf, konfigurasi AI belum diatur.", parseMode: null };
    }

    let history = chatHistories[chatId] || [];
    const isVisionRequest = imageBase64 && imageMimeType;
    const modelToUse = isVisionRequest ? GEMINI_VISION_MODEL_NAME : GEMINI_TEXT_MODEL_NAME;
    const apiUrl = `${GEMINI_API_URL_BASE}${modelToUse}:generateContent?key=${GEMINI_API_KEY}`;

    console.log(`Using model: ${modelToUse} for chat ${chatId}. Vision request: ${isVisionRequest}`);

    // Tambahkan konteks nama & system instruction jika history kosong
    if (history.length === 0) {
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
    }

    // --- Struktur Konten Baru ---
    const currentUserTurnContent = [];
    // 1. Tambahkan teks prompt pengguna
    if (newUserPrompt) {
        currentUserTurnContent.push({ text: newUserPrompt });
    }
    // 2. Tambahkan data gambar JIKA ADA
    if (isVisionRequest) {
        currentUserTurnContent.push({
            inlineData: {
                mimeType: imageMimeType,
                data: imageBase64
            }
        });
        // Jika tidak ada teks prompt (misal, hanya reply gambar), tambahkan prompt default
        if (!newUserPrompt) {
            currentUserTurnContent.unshift({ text: "Describe this image." }); // Taruh di awal agar gambar setelahnya
             console.log("No text prompt provided with image, using default 'Describe this image.'");
        }
    }
    // Tambahkan giliran pengguna ke history
    history.push({ role: "user", parts: currentUserTurnContent });


    // --- Pemotongan History (Mungkin perlu lebih agresif jika ada gambar) ---
     const currentHistoryLength = history.reduce((acc, turn) => acc + JSON.stringify(turn).length, 0);
     const MAX_HISTORY_SIZE_BYTES = 50000; // Batas ukuran history dalam byte (estimasi)

     if (history.length > MAX_HISTORY_LENGTH || currentHistoryLength > MAX_HISTORY_SIZE_BYTES) {
        console.warn(`History for chat ${chatId} exceeding limits (Length: ${history.length}/${MAX_HISTORY_LENGTH}, Size: ${currentHistoryLength}/${MAX_HISTORY_SIZE_BYTES}), trimming...`);
        // Implementasi pemotongan yang lebih baik mungkin diperlukan,
        // untuk saat ini kita potong berdasarkan jumlah giliran saja seperti sebelumnya
        // TAPI kita kurangi turnsToKeep jika ada gambar untuk menghemat token/ukuran
        const systemPromptsCount = history.filter(h => h.role === 'system').length;
        const conversationTurns = (history.length - systemPromptsCount); // Hitung giliran user+model
        const turnsToKeep = isVisionRequest ? 3 : 5; // Lebih sedikit giliran jika ada gambar

        if (conversationTurns > turnsToKeep * 2) { // *2 karena user+model = 1 turn pair
            const itemsToRemove = Math.max(0, conversationTurns - (turnsToKeep * 2));
             if (itemsToRemove > 0) {
                 // Hapus dari setelah system prompt
                 history.splice(systemPromptsCount, itemsToRemove);
                 console.log(`Trimmed ${itemsToRemove} items (turns) from history for chat ${chatId}`);
             }
        }
     }
    // --- Akhir Pemotongan History ---

    const historyBeforeResponse = [...history]; // Simpan state sebelum request

    console.log(`Calling Gemini API (${modelToUse}) for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt || '(Image only)'}". Grounding: ${enableGrounding}`);

    // --- Request Body Disesuaikan ---
    const requestBody = {
        // System instruction sekarang HARUS di luar 'contents' untuk model 1.5
        systemInstruction: {
            role: "system", // Atau cukup parts array saja
            parts: history.filter(h => h.role === 'system').flatMap(h => h.parts)
        },
        // 'contents' hanya berisi giliran 'user' dan 'model'
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 0.8, // Mungkin turunkan sedikit untuk deskripsi gambar
            topP: 0.9,
            // response_mime_type: "text/plain" // Coba aktifkan jika didukung
        },
        // Safety settings (opsional, sama seperti sebelumnya)
        // safetySettings: [...]
    };

    // Tambahkan tools untuk grounding jika diaktifkan (HANYA untuk request non-vision?)
    // Beberapa model mungkin tidak mendukung grounding DAN vision bersamaan. Cek dokumentasi model spesifik.
    // Untuk amannya, kita nonaktifkan grounding jika ini request vision.
    if (enableGrounding && !isVisionRequest) {
        requestBody.tools = [{'google_search': {}}];
        console.log("Grounding enabled (google_search) for this text request.");
    } else if (enableGrounding && isVisionRequest) {
        console.warn("Grounding was requested but disabled because this is a vision request.");
        enableGrounding = false; // Pastikan flagnya false
    }

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000 // Naikkan timeout untuk vision/grounding
        });

        const candidate = response.data?.candidates?.[0];
        let aiResponseText = '';

        if (!candidate) {
             console.error("Gemini response missing candidates.", JSON.stringify(response.data, null, 2));
             chatHistories[chatId] = historyBeforeResponse; // Rollback
             return { text: `Waduh ${userName}, AI-nya nggak ngasih respon nih kali ini. Coba lagi ya.`, parseMode: null };
        }

        // Handle potential finish reasons (misal: safety)
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
             console.warn(`Gemini response finished with reason: ${candidate.finishReason}. Content may be incomplete or blocked.`);
             // Jika karena SAFETY, ambil teks jika ada, atau beri pesan khusus
             aiResponseText = candidate.content?.parts?.[0]?.text || '';
             if (!aiResponseText) {
                 chatHistories[chatId] = historyBeforeResponse; // Rollback history
                 return { text: `Maaf ${userName}, respons AI diblokir karena alasan keamanan (${candidate.finishReason}). Coba prompt yang berbeda ya.`, parseMode: null };
             }
             // Jika ada teks sebagian, tambahkan catatan
             aiResponseText += `\n\n(Respons mungkin tidak lengkap karena: ${candidate.finishReason})`;
        } else {
             aiResponseText = candidate.content?.parts?.[0]?.text;
        }


        // Ambil metadata grounding (citationMetadata) HANYA jika grounding aktif
        const groundingAttributions = (enableGrounding && candidate.citationMetadata?.citationSources) ? candidate.citationMetadata.citationSources : null;

        if (aiResponseText) {
            console.log("Original AI text received:", aiResponseText.substring(0,100) + "...");
            aiResponseText = stripMarkdown(aiResponseText); // Bersihkan Markdown
            console.log("AI text after stripping Markdown:", aiResponseText.substring(0,100) + "...");

            // Tambahkan giliran model ke history (HANYA teks)
            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history; // Update history

            let finalResponseText = aiResponseText;
            let parseMode = null; // Tetap null

            // Proses Atribusi Grounding (jika ada dan aktif)
            if (groundingAttributions && groundingAttributions.length > 0) {
                 // ... (Kode untuk menambahkan sumber grounding tetap sama seperti sebelumnya) ...
                console.log("Grounding attributions found:", groundingAttributions.length);
                finalResponseText += "\n\nSumber:";

                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        title: source.displayName || source.uri?.split('/').pop() || source.uri
                    }))
                    .filter(source => source.uri)
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri));

                if (sources.length > 0) {
                    sources.forEach((source, index) => {
                        finalResponseText += `\n${index + 1}. ${source.title || source.uri}`;
                    });
                    finalResponseText += "\n";
                } else {
                    finalResponseText += " (Tidak dapat memformat sumber)";
                    console.warn("Could not format any valid sources from grounding attributions.");
                }

            } else if (enableGrounding) { // Jika grounding aktif tapi tak ada hasil
                console.log("Grounding was enabled, but no attributions found in response.");
            }

            return { text: finalResponseText.trim(), parseMode: null };

        } else if (!aiResponseText && isVisionRequest) {
            // Kasus khusus: Vision request tapi tidak ada teks balasan
             console.warn("Vision request successful but no text description returned.");
             history.push({ role: "model", parts: [{ text: "(Deskripsi gambar tidak tersedia)" }] }); // Simpan placeholder
             chatHistories[chatId] = history;
             return { text: `Hmm ${userName}, AI-nya bisa lihat gambarnya, tapi nggak bisa ngasih deskripsi teksnya nih. Aneh ya.`, parseMode: null };
        } else {
            // Kasus tidak ada teks sama sekali (bukan vision atau vision gagal total)
            console.error("Gemini response format unexpected or empty text.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse; // Rollback
            return { text: "Waduh, AI-nya lagi diem nih, nggak ngasih jawaban.", parseMode: null };
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        chatHistories[chatId] = historyBeforeResponse; // Rollback
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI-nya (${modelToUse}). Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI (${modelToUse}), coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya (${modelToUse}), coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            errorMsg = `Error dari AI (${modelToUse} - ${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
            if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah (${modelToUse}) habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && apiError.message.includes("inline data")) {
                 errorMsg = `Waduh ${userName}, sepertinya ada masalah pas ngirim data gambar/file ke AI (${modelToUse}). Ukuran atau formatnya mungkin? ${apiError.message}`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI (${modelToUse}) lagi ada masalah internal nih. Coba beberapa saat lagi.`;
        }
        return { text: errorMsg, parseMode: null };
    }
}
// --- Akhir Fungsi Gemini ---


// --- >>> Handler Utama Vercel DIMODIFIKASI <<< ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed' }); }
    if (!req.body || typeof req.body !== 'object') {
        console.log('Received invalid or empty request body.');
        return res.status(200).send('OK - Invalid body');
    }

    console.log('Received update:', JSON.stringify(req.body, null, 2));
    const update = req.body;

    if (update.message && update.message.chat && update.message.from) {
        const chatId = update.message.chat.id;
        const message = update.message;
        const messageText = (message.text || "").trim();
        const chatType = message.chat.type;
        const messageId = message.message_id;
        const userId = message.from.id;
        const username = message.from.username;
        const firstName = message.from.first_name;
        const repliedToMessage = message.reply_to_message; // Pesan yang dibalas

        // --- Dapatkan nama panggilan ---
        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

        // --- Inisialisasi Variabel Pemrosesan ---
        let shouldProcessAI = false;
        let promptForAI = "";
        let messageIdToReply = messageId; // Default balas ke pesan trigger
        let enableGrounding = false;
        let triggerWordUsed = null;
        let imageBase64 = null;      // Untuk menyimpan data gambar base64
        let imageMimeType = null;    // Untuk menyimpan tipe MIME gambar

        const lowerCaseText = messageText.toLowerCase();
        const BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        // --- 1. Handle /clear (Tetap di awal) ---
        if (lowerCaseText === '/clear') {
            if (chatHistories[chatId]) {
                delete chatHistories[chatId];
                await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan!`, messageIdToReply);
                console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
            } else {
                await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus.`, messageIdToReply);
            }
            return res.status(200).send('OK');
        }

        // --- >>> 2. Cek Balasan ke Gambar (Vision Trigger) <<< ---
        if (repliedToMessage && repliedToMessage.photo && repliedToMessage.photo.length > 0) {
            console.log(`Detected reply to a message with photo by ${nameForAIContext} (${userId})`);

            // Ambil file_id dari resolusi tertinggi (biasanya terakhir)
            const photo = repliedToMessage.photo[repliedToMessage.photo.length - 1];
            const fileId = photo.file_id;

            try {
                 // Kirim 'typing' action lebih awal
                 await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });

                // Step 1: Get file path from Telegram API
                console.log(`Getting file path for file_id: ${fileId}`);
                const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                const filePath = getFileResponse.data?.result?.file_path;

                if (!filePath) {
                    throw new Error('File path not found in Telegram response.');
                }
                console.log(`Got file path: ${filePath}`);

                // Step 2: Construct download URL
                const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

                // Step 3: Download the image data as ArrayBuffer
                console.log(`Downloading image from: ${fileUrl}`);
                const imageResponse = await axios.get(fileUrl, {
                    responseType: 'arraybuffer' // Penting!
                });

                // Step 4: Convert to Base64
                imageBase64 = Buffer.from(imageResponse.data).toString('base64');

                // Step 5: Determine MIME type (Asumsi JPEG dari Telegram, bisa diperbaiki jika perlu)
                // Anda bisa coba cek beberapa byte pertama (magic numbers) jika ingin lebih akurat
                if (filePath.toLowerCase().endsWith('.png')) {
                    imageMimeType = 'image/png';
                } else if (filePath.toLowerCase().endsWith('.webp')) {
                    imageMimeType = 'image/webp';
                } else {
                    imageMimeType = 'image/jpeg'; // Default
                }

                console.log(`Image downloaded (${(imageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded to Base64. MimeType: ${imageMimeType}`);

                // Tentukan prompt berdasarkan teks balasan pengguna
                const visionTriggers = ["ini apa", "apa ini", "jelaskan", "deskripsikan", "gambar apa", "le ini apa"];
                if (!messageText || visionTriggers.some(trigger => lowerCaseText.includes(trigger))) {
                    promptForAI = ""; // Gunakan prompt default "Describe this image" di getGeminiResponse
                    triggerWordUsed = "vision_describe";
                } else {
                    promptForAI = messageText; // Gunakan teks pengguna sebagai prompt tambahan
                    triggerWordUsed = "vision_query";
                }
                shouldProcessAI = true; // Siap proses dengan AI Vision
                enableGrounding = false; // Nonaktifkan grounding untuk vision
                // messageIdToReply = messageId; // Balas ke pesan teks pengguna yg me-reply

            } catch (error) {
                console.error(`Error fetching or processing image from Telegram (file_id: ${fileId}):`, error.message);
                await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil atau proses gambarnya nih dari Telegram. Coba lagi nanti ya.`, messageId);
                // Jangan lanjutkan pemrosesan AI jika gambar gagal diambil
                shouldProcessAI = false;
            }
        }


        // --- 3. Jika BUKAN Balasan ke Gambar, Cek Trigger Teks Biasa ---
        if (!shouldProcessAI) { // Hanya jika belum di-set oleh logic vision di atas
            enableGrounding = false; // Reset grounding flag

            // --- Cek Trigger Grounding ---
            const groundingTriggers = ['/info ', 'inpo ', 'kabar ', '/po '];
            for (const trigger of groundingTriggers) {
                if (lowerCaseText.startsWith(trigger)) {
                    triggerWordUsed = trigger.trim();
                    promptForAI = messageText.substring(trigger.length).trim();
                    if (promptForAI) {
                        shouldProcessAI = true;
                        enableGrounding = true; // Aktifkan Grounding
                        console.log(`Processing TEXT message ${messageId} WITH grounding (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId})`);
                    } else {
                        await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari ${triggerWordUsed} apa? Contoh: ${triggerWordUsed} berita terkini tentang AI`, messageIdToReply);
                        shouldProcessAI = false;
                    }
                    break;
                }
            }

            // --- Jika BUKAN Grounding, Cek Kondisi Lain (Private, Group Trigger, Reply Teks) ---
            if (!triggerWordUsed && !shouldProcessAI) {
                if (chatType === 'private') {
                    // Jangan proses jika pesan teks kosong di private chat
                    if (messageText) {
                        shouldProcessAI = true;
                        promptForAI = messageText;
                        triggerWordUsed = 'private_chat';
                        enableGrounding = false; // Default grounding off untuk chat biasa
                        // Cek apakah user ingin grounding di private chat
                        if (lowerCaseText.startsWith("cari info ") || lowerCaseText.startsWith("inpo ")) {
                             const query = messageText.substring(messageText.indexOf(" ") + 1).trim();
                             if(query) {
                                promptForAI = query;
                                enableGrounding = true;
                                triggerWordUsed = 'private_grounding';
                                console.log(`Processing private message ${messageId} WITH grounding (Implicit trigger) from ${nameForAIContext} (${userId})`);
                             }
                        } else {
                             console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
                        }
                    } else {
                         console.log(`Ignoring empty private message ${messageId} from ${nameForAIContext} (${userId})`);
                         shouldProcessAI = false;
                    }
                } else if (chatType === 'group' || chatType === 'supergroup') {
                    // --- Cek Trigger Chat Biasa (Grup) ---
                    const chatTriggers = ['/chat ', 'lele ', 'le ', 'tanya '];
                    for (const trigger of chatTriggers) {
                        if (lowerCaseText.startsWith(trigger)) {
                            triggerWordUsed = trigger.trim();
                            promptForAI = messageText.substring(trigger.length).trim();
                            break;
                        }
                    }

                    // --- Cek Reply ke Bot (Teks) ---
                    if (!triggerWordUsed && BOT_USER_ID && repliedToMessage?.from?.id === BOT_USER_ID && repliedToMessage.text) {
                        // Pastikan yang direply BUKAN gambar (sudah ditangani di atas)
                         if (!repliedToMessage.photo) {
                              triggerWordUsed = 'reply_to_bot_text';
                              promptForAI = messageText; // Gunakan teks balasan user
                              // Tambahkan konteks dari pesan bot yang direply
                              promptForAI = `Ini adalah respons saya sebelumnya: "${repliedToMessage.text}"\n\nSekarang tanggapi ini: "${messageText}"`;
                              console.log(`Added context from bot's previous message ${repliedToMessage.message_id}`);
                              // messageIdToReply = repliedToMessage.message_id; // Opsi: Balas ke pesan bot
                         }
                    }

                   // --- Tambah Konteks jika Reply ke Pesan Teks Orang Lain (berlaku untuk trigger chat) ---
                   // (Pastikan BUKAN reply ke bot atau gambar, sudah ditangani)
                   if (triggerWordUsed && triggerWordUsed !== 'reply_to_bot_text' && repliedToMessage && repliedToMessage.text && repliedToMessage.from?.id !== BOT_USER_ID) {
                        const repliedText = repliedToMessage.text;
                        let originalSenderName = 'seseorang';
                         const repliedFrom = repliedToMessage.from;
                         if (repliedFrom) {
                             const repliedUsername = repliedFrom.username ? repliedFrom.username.toLowerCase() : null;
                             const repliedNickname = repliedUsername ? userNicknames[repliedUsername] : null;
                            originalSenderName = repliedNickname || repliedFrom.first_name || (repliedFrom.username ? `@${repliedFrom.username}` : `User ${repliedFrom.id}`);
                         }

                        // Format ulang promptForAI yang sudah ada (dari trigger chat)
                        promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya berikut: "${promptForAI}"`;
                        console.log(`Added context from replied text message ${repliedToMessage.message_id}`);
                        messageIdToReply = repliedToMessage.message_id; // Balas ke pesan asli yang direply user
                    }


                    // --- Tentukan apakah akan proses AI (Teks Biasa Grup) ---
                    if (triggerWordUsed && promptForAI) {
                        shouldProcessAI = true;
                        enableGrounding = false; // Default off untuk chat biasa grup
                        console.log(`Trigger TEXT '${triggerWordUsed}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
                    } else if (triggerWordUsed && !promptForAI && triggerWordUsed !== 'reply_to_bot_text') {
                        let helpText = `Iya ${nameForBotGreeting}? Mau ${triggerWordUsed} apa nih? Contoh: ${triggerWordUsed} jelaskan soal black hole`;
                        await sendMessage(chatId, helpText, messageIdToReply);
                        shouldProcessAI = false;
                    } else if (!triggerWordUsed && messageText) { // Hanya log jika ada teks tapi bukan trigger
                        console.log(`Ignoring non-trigger text message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
                        shouldProcessAI = false;
                    }
                }
                 else if (!messageText && !repliedToMessage?.photo) { // Abaikan jika pesan teks kosong DAN BUKAN reply ke foto
                    console.log(`Ignoring message ${messageId} in chat ${chatId} because it has no text content and is not a reply to a photo.`);
                    shouldProcessAI = false;
                }
                else {
                    console.log(`Ignoring message from unsupported chat type: ${chatType} or unhandled condition.`);
                    shouldProcessAI = false;
                }
            }
        }


        // --- 4. Proses AI jika diperlukan ---
        if (shouldProcessAI) {
             const effectivePromptLength = (promptForAI || "").length + (imageBase64 ? imageBase64.length : 0); // Perkiraan kasar
             const MAX_EFFECTIVE_PROMPT = 4194304; // Batas lebih besar untuk vision/history

            if (effectivePromptLength > MAX_EFFECTIVE_PROMPT) {
                await sendMessage(chatId, `pencet /clear`, messageIdToReply);
            } else if (!promptForAI && !imageBase64) {
                 // Kondisi aneh, seharusnya tidak terjadi jika shouldProcessAI=true
                 console.warn(`shouldProcessAI is true but both prompt and image are missing for chat ${chatId}, message ${messageId}. Skipping.`);
            }
             else {
                // Kirim 'typing' action JIKA BELUM dikirim (misal untuk request teks)
                if (!imageBase64) { // Jika request vision, typing sudah dikirim saat fetch gambar
                    try {
                        await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                    } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }
                }

                // Panggil Gemini (sudah menghandle vision/text/grounding secara internal)
                const aiResponseObject = await getGeminiResponse(
                    chatId,
                    promptForAI,
                    nameForAIContext,
                    enableGrounding, // Akan dinonaktifkan otomatis di dalam jika ada gambar
                    imageBase64,     // Kirim data gambar
                    imageMimeType    // Kirim tipe mime
                );

                // Kirim balasan AI
                await sendMessage(chatId, aiResponseObject.text, messageIdToReply); // Balas ke pesan trigger atau pesan yg direply (tergantung logic di atas)
            }
        }

    } else if (update.message && update.message.chat) {
        const chatId = update.message.chat.id;
        console.log(`Ignoring non-text or incomplete message update in chat ${chatId || 'unknown'}`);
    } else {
        console.log('Ignoring update that is not a message or lacks required fields.');
    }

    res.status(200).send('OK');
};