// api/webhook.js
const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js'); // Pastikan file ini ada
const userNicknames = require('./userNicknames.js'); // Pastikan file ini ada

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
// Sesuaikan nama model jika perlu, pastikan yang image generation mendukung input gambar
const GEMINI_VISION_MODEL_NAME = "gemini-2.0-flash";
const GEMINI_TEXT_MODEL_NAME = "gemini-2.0-flash";
const GEMINI_IMAGE_MODEL_NAME = "gemini-2.0-flash-exp-image-generation"; // Model ini mendukung text+image in/out
const GEMINI_API_URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/`;

// --- Fungsi sendMessage ---
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
        if (error.response && error.response.status === 400 && error.response.data.description.includes("can't parse entities")) {
             console.error(`!!! Potential lingering Markdown issue detected despite parse_mode removal for message to ${chatId}. Raw text: ${text.substring(0, 100)}...`);
             const fallbackText = text.replace(/[*_`\[\]()]/g, ''); // Basic stripping for fallback
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

// --- Fungsi sendPhotoFromBase64 ---
async function sendPhotoFromBase64(chatId, base64Data, mimeType, caption = '', replyToMessageId = null) {
    if (!BOT_TOKEN) {
        console.error("Bot token is not set for sending photo.");
        return;
    }
    if (!base64Data || !mimeType) {
        console.error(`Invalid base64 data or mimeType provided for chat ${chatId}`);
        await sendMessage(chatId, "Waduh, ada error internal pas mau kirim gambar (data invalid).", replyToMessageId);
        return;
    }

    try {
        const imageBuffer = Buffer.from(base64Data, 'base64');
        const fileName = `generated_image.${mimeType.split('/')[1] || 'png'}`; // Ambil ekstensi dari mimeType

        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('photo', imageBuffer, { filename: fileName, contentType: mimeType });
        if (caption) { formData.append('caption', caption.substring(0, 1024)); } // Batas caption Telegram
        if (replyToMessageId) { formData.append('reply_to_message_id', replyToMessageId); }

        await axios.post(`${TELEGRAM_API}/sendPhoto`, formData, {
            headers: formData.getHeaders(),
            timeout: 60000 // Timeout 60 detik untuk upload
        });
        console.log(`Photo sent successfully to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));

    } catch (error) {
        console.error(`Error sending photo to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorMsg = `Aduh, maaf banget, gagal ngirim gambarnya nih.`;
        if (error.response?.data?.description) {
            errorMsg += ` (${error.response.data.description})`;
        } else if (error.code === 'ECONNABORTED') {
            errorMsg = `Aduh, kelamaan nih upload gambarnya ke Telegram. Coba lagi nanti.`;
        } else if (error.message && error.message.includes('FILE_TOO_LARGE')) {
            errorMsg = `Aduh, gambarnya kegedean buat dikirim ke Telegram (>5MB setelah diencode?).`;
        }
        await sendMessage(chatId, errorMsg, replyToMessageId);
    }
}
// --- Akhir Fungsi sendPhotoFromBase64 ---

// --- Riwayat & Nama Panggilan ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 50; // Jumlah maksimal giliran user+model
const MAX_HISTORY_SIZE_BYTES = 50000; // Perkiraan batas ukuran history dalam byte
// --- Akhir Riwayat ---

// --- Fungsi stripMarkdown ---
function stripMarkdown(text) {
    if (!text) return text;

    const originalLines = text.split('\n');
    const processedLines = [];
    const listItemRegex = /^(\s*)(?:[*\-+]|\d+\.)\s+(.*)$/; // Handle *, -, +, 1.
    const headerRegex = /^\s*#+\s+/; // Handle #, ##, etc.
    const hrRegex = /^\s*([-*_]){3,}\s*$/; // Handle ---, ***, ___
    const categoryHeaderRegex = /^(\s*)([^:\n]+:)\s*$/; // Match "Category:"
    const startsWithWhitespaceRegex = /^\s+/;

    for (let i = 0; i < originalLines.length; i++) {
        const line = originalLines[i];
        let processedLine = line;
        let addCheckMark = false;

        // Abaikan horizontal rules
        if (hrRegex.test(line)) {
            continue;
        }

        // Hapus heading markdown
        processedLine = processedLine.replace(headerRegex, '');
        // Hapus karakter markdown umum
        processedLine = processedLine.replace(/[*_`[\]()]/g, '');
        // Hapus URL (opsional, bisa mengganggu jika URL penting)
        processedLine = processedLine.replace(/\bhttps?:\/\/\S+/gi, '');

        const listItemMatch = line.match(listItemRegex);
        const categoryHeaderMatch = processedLine.match(categoryHeaderRegex);
        const nextLine = originalLines[i + 1];

        if (listItemMatch) {
            const indent = listItemMatch[1]; // Pertahankan indentasi asli
            let content = listItemMatch[2];
            // Hapus markdown lagi dari konten list item
            content = content.replace(/[*_`[\]()]/g, '').replace(/\bhttps?:\/\/\S+/gi, '');
            processedLine = indent + '✅ ' + content.trim();
            addCheckMark = false; // Sudah ditambahkan
        } else if (categoryHeaderMatch && !startsWithWhitespaceRegex.test(categoryHeaderMatch[1]) && nextLine && listItemRegex.test(nextLine)) {
            // Jika baris adalah "Category:" dan baris berikutnya adalah list item, tambahkan centang
             processedLine = processedLine.trim(); // Hapus spasi ekstra
             addCheckMark = true;
        } else {
             processedLine = processedLine.trim(); // Hapus spasi ekstra untuk baris biasa
             addCheckMark = false;
        }

        // Tambahkan centang jika diperlukan (untuk header kategori)
        if (addCheckMark && processedLine) {
            processedLine = '✅ ' + processedLine;
        }

        // Hanya tambahkan baris jika tidak kosong setelah diproses
        if (processedLine.trim()) {
            processedLines.push(processedLine);
        } else if (processedLines.length > 0 && processedLines[processedLines.length - 1].trim() !== '') {
            // Tambahkan satu baris kosong jika baris sebelumnya tidak kosong (menjaga paragraf)
            processedLines.push('');
        }
    }

    // Gabungkan kembali baris-baris
    let resultText = processedLines.join('\n');

    // Pembersihan akhir
    resultText = resultText.replace(/ +/g, ' '); // Ganti spasi ganda jadi tunggal
    resultText = resultText.replace(/✅(\S)/g, '✅ $1'); // Pastikan ada spasi setelah centang
    resultText = resultText.replace(/\n\s*\n/g, '\n\n'); // Pastikan maksimal 2 baris baru
    resultText = resultText.replace(/\n{3,}/g, '\n\n'); // Pastikan maksimal 2 baris baru (lagi)

    return resultText.trim(); // Hapus spasi di awal/akhir hasil akhir
}
// --- Akhir Fungsi stripMarkdown ---

// --- Fungsi Panggil Gemini (Text & Vision) ---
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

    // Inisialisasi history jika kosong
    if (history.length === 0) {
        // Tambahkan konteks pengguna saat ini jika belum ada
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
        // Tambahkan instruksi sistem utama
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
        console.log(`Initialized history for chat ${chatId} with system instructions and user context: ${userName}`);
    } else {
        // Pastikan konteks pengguna diperbarui jika nama berubah (jarang terjadi tapi mungkin)
        const userContextIndex = history.findIndex(h => h.role === 'system' && h.parts[0]?.text?.startsWith('Pengguna saat ini adalah'));
        if (userContextIndex !== -1) {
            if (history[userContextIndex].parts[0].text !== `Pengguna saat ini adalah ${userName}.`) {
                 console.log(`Updating user context in history for chat ${chatId} to: ${userName}`);
                 history[userContextIndex] = { role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] };
            }
        } else {
            // Jika tidak ada konteks pengguna (seharusnya tidak terjadi setelah inisialisasi), tambahkan di awal setelah instruksi sistem
            const systemInstructionIndex = history.findIndex(h => h.role === 'system' && h.parts[0]?.text === systemInstructionText);
            if (systemInstructionIndex !== -1) {
                 history.splice(systemInstructionIndex + 1, 0, { role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
                 console.log(`Added missing user context to history for chat ${chatId}: ${userName}`);
            } else {
                 // Jika instruksi sistem juga hilang, inisialisasi ulang (kasus aneh)
                 history.unshift({ role: "system", parts: [{ "text": systemInstructionText }] });
                 history.unshift({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
                 console.warn(`Re-initializing system instructions and user context for chat ${chatId}`);
            }
        }
    }


    // Buat konten untuk giliran pengguna saat ini
    const currentUserTurnContent = [];
    if (newUserPrompt) {
        currentUserTurnContent.push({ text: newUserPrompt });
    }
    // Tambahkan data gambar jika ini permintaan vision
    if (isVisionRequest) {
        currentUserTurnContent.push({
            inlineData: {
                mimeType: imageMimeType,
                data: imageBase64
            }
        });
        // Jika tidak ada teks prompt bersama gambar, tambahkan prompt default
        if (!newUserPrompt) {
            currentUserTurnContent.unshift({ text: "Jelaskan atau komentari gambar ini." }); // Prompt default untuk vision
             console.log("No text prompt provided with image for vision, using default 'Jelaskan atau komentari gambar ini.'");
        }
    }
    history.push({ role: "user", parts: currentUserTurnContent });


    // --- Pemotongan History (jika terlalu panjang) ---
    const currentHistoryLength = history.reduce((acc, turn) => acc + JSON.stringify(turn).length, 0);

    if (history.length > MAX_HISTORY_LENGTH || currentHistoryLength > MAX_HISTORY_SIZE_BYTES) {
       console.warn(`History for chat ${chatId} exceeding limits (Length: ${history.length}/${MAX_HISTORY_LENGTH}, Size: ${currentHistoryLength}/${MAX_HISTORY_SIZE_BYTES}), trimming...`);
       const systemPrompts = history.filter(h => h.role === 'system');
       let conversationTurns = history.filter(h => h.role !== 'system');

       // Hitung jumlah giliran user/model yang akan dihapus
       let turnsToRemove = Math.max(0, conversationTurns.length - MAX_HISTORY_LENGTH + systemPrompts.length); // Hapus berdasarkan jumlah giliran
       if (turnsToRemove === 0 && currentHistoryLength > MAX_HISTORY_SIZE_BYTES) {
           // Jika panjang OK tapi ukuran > batas, hapus beberapa giliran awal
           turnsToRemove = Math.ceil(conversationTurns.length * 0.2); // Hapus 20% giliran awal
           console.log(`History size exceeded, trimming approx 20% (${turnsToRemove}) oldest turns.`);
       }


       if (turnsToRemove > 0) {
           // Hapus giliran user/model terlama
           conversationTurns.splice(0, turnsToRemove);
           // Gabungkan kembali dengan system prompts
           chatHistories[chatId] = [...systemPrompts, ...conversationTurns];
           history = chatHistories[chatId]; // Update history yang akan digunakan
           console.log(`Trimmed ${turnsToRemove} conversation turns from history for chat ${chatId}. New length: ${history.length}`);
       } else {
            console.log(`History within limits, no trimming needed for chat ${chatId}.`);
       }
    }
    // --- Akhir Pemotongan History ---

    const historyBeforeResponse = [...history]; // Salinan untuk rollback jika error

    console.log(`Calling Gemini API (${modelToUse}) for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt || '(Image only)'}". Grounding: ${enableGrounding}`);
    // console.log("History sent to Gemini:", JSON.stringify(history, null, 2)); // Debug: Tampilkan history lengkap (bisa sangat panjang)

    // Format request body
    const requestBody = {
        // Pisahkan system instructions dari contents
        systemInstruction: {
            role: "system",
            parts: history.filter(h => h.role === 'system').flatMap(h => h.parts) // Gabungkan semua system parts
        },
        contents: history.filter(h => h.role === 'user' || h.role === 'model'), // Hanya user & model turns
        generationConfig: {
            temperature: 0.8,
            topP: 0.9,
            // maxOutputTokens: 8192, // Bisa diatur jika perlu batas output
        },
        // safetySettings: [ // Contoh Konfigurasi Keamanan (sesuaikan)
        //     { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        //     { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        //     { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        //     { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
        // ]
    };

    // Tambahkan tools jika grounding diaktifkan (hanya untuk teks)
    if (enableGrounding && !isVisionRequest) {
        requestBody.tools = [{'googleSearchRetrieval': {}}]; // Gunakan nama tool yang benar (cek dokumentasi terbaru)
        console.log("Grounding enabled (googleSearchRetrieval) for this text request.");
    } else if (enableGrounding && isVisionRequest) {
        console.warn("Grounding was requested but disabled because this is a vision request.");
        enableGrounding = false; // Pastikan false jika vision
    }

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000 // Timeout 2 menit
        });

        const candidate = response.data?.candidates?.[0];
        let aiResponseText = '';

        if (!candidate) {
             console.error("Gemini response missing candidates.", JSON.stringify(response.data, null, 2));
             // Kembalikan history ke state sebelum request gagal
             chatHistories[chatId] = historyBeforeResponse;
             return { text: `Waduh ${userName}, AI-nya nggak ngasih respon nih kali ini. Coba lagi ya.`, parseMode: null };
        }

        // Cek finishReason
        if (candidate.finishReason && candidate.finishReason !== 'STOP' && candidate.finishReason !== 'MAX_TOKENS') {
             console.warn(`Gemini response finished with reason: ${candidate.finishReason}. Content may be incomplete or blocked.`);
             // Coba ambil teks jika ada, meskipun finishReason aneh
             aiResponseText = candidate.content?.parts?.map(part => part.text).filter(Boolean).join('\n') || '';
             if (!aiResponseText) {
                 // Jika tidak ada teks sama sekali dan diblokir
                 chatHistories[chatId] = historyBeforeResponse; // Rollback history
                 const safetyRatings = candidate.safetyRatings ? ` (${candidate.safetyRatings.map(r => r.category + ':'+r.probability).join(', ')})` : '';
                 return { text: `Maaf ${userName}, respons AI diblokir karena alasan ${candidate.finishReason}${safetyRatings}. Coba prompt yang berbeda ya.`, parseMode: null };
             }
             // Tambahkan catatan jika respons tidak lengkap
             aiResponseText += `\n\n*(Peringatan: Respons mungkin tidak lengkap atau dihentikan karena: ${candidate.finishReason})*`;
        } else {
             // Ambil teks dari semua parts jika ada (jarang terjadi untuk model teks, tapi antisipasi)
             aiResponseText = candidate.content?.parts?.map(part => part.text).filter(Boolean).join('\n');
        }

        // Cek apakah ada tool call (misal search) tapi tidak ada teks jawaban
         const functionCalls = candidate.content?.parts?.filter(part => part.functionCall);
         if (functionCalls?.length > 0 && !aiResponseText) {
             console.warn("Gemini response contains function calls but no text output. Assuming search occurred but no summary generated.");
             // Rollback history karena tidak ada jawaban model untuk disimpan
             chatHistories[chatId] = historyBeforeResponse;
             return { text: `Hmm ${userName}, AI sepertinya mencari informasi tapi tidak memberikan rangkuman. Coba tanya lagi dengan lebih spesifik.`, parseMode: null };
         }

        // Dapatkan Atribusi Grounding jika ada
        const groundingAttributions = (enableGrounding && candidate.citationMetadata?.citationSources) ? candidate.citationMetadata.citationSources : null;

        if (aiResponseText) {
            console.log("Original AI text received:", aiResponseText.substring(0,150) + "..."); // Log lebih panjang
            const strippedText = stripMarkdown(aiResponseText); // Bersihkan markdown
            console.log("AI text after stripping Markdown:", strippedText.substring(0,150) + "...");

            // Simpan respons AI yang sudah dibersihkan ke history
            history.push({ role: "model", parts: [{ text: strippedText }] });
            chatHistories[chatId] = history; // Update history global

            let finalResponseText = strippedText;

            // Tambahkan sumber jika grounding aktif dan ada atribusi
            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", groundingAttributions.length);
                finalResponseText += "\n\n---"; // Pemisah

                // Filter dan format sumber unik
                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        // Gunakan displayName jika ada, jika tidak coba ambil dari URI, fallback ke URI penuh
                        title: source.displayName || source.uri?.split('/').pop()?.split('?')[0]?.replace(/-/g, ' ') || source.uri
                    }))
                    .filter(source => source.uri) // Hanya yang punya URI
                    // Unik berdasarkan URI
                    .filter((source, index, self) => index === self.findIndex((s) => s.uri === source.uri));

                if (sources.length > 0) {
                     finalResponseText += `\nSumber:`;
                    sources.slice(0, 5).forEach((source, index) => { // Batasi jumlah sumber yg ditampilkan
                        finalResponseText += `\n${index + 1}. ${source.title || source.uri}`; // Tampilkan judul atau URI
                        // Jangan tampilkan URI lengkap jika terlalu panjang dan sudah ada judul
                        // if (source.uri && (!source.title || source.title === source.uri)) {
                        //     finalResponseText += ` (${source.uri.substring(0, 50)}...)`;
                        // }
                    });
                     if (sources.length > 5) finalResponseText += `\n... (dan ${sources.length - 5} sumber lainnya)`;
                    finalResponseText += "\n";
                } else {
                    finalResponseText += "\n(Tidak dapat memformat sumber dari atribusi)";
                    console.warn("Could not format any valid sources from grounding attributions:", groundingAttributions);
                }
            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no valid attributions found in response.");
                // finalResponseText += "\n\n*(Tidak ditemukan sumber spesifik untuk informasi ini)*"; // Opsional: Beri tahu user
            }

            return { text: finalResponseText.trim(), parseMode: null }; // Selalu kirim tanpa parseMode

        } else if (!aiResponseText && isVisionRequest) {
             // Kasus khusus: Vision berhasil tapi tidak ada teks deskripsi
             console.warn("Vision request successful but no text description returned.");
             // Tetap simpan giliran model (kosong) agar history konsisten
             history.push({ role: "model", parts: [{ text: "(Deskripsi gambar tidak tersedia)" }] });
             chatHistories[chatId] = history;
             return { text: `Hmm ${userName}, AI-nya bisa lihat gambarnya, tapi nggak bisa ngasih deskripsi teksnya nih. Aneh ya.`, parseMode: null };
        } else {
            // Jika tidak ada teks sama sekali (bukan karena blokir)
            console.error("Gemini response format unexpected or empty text.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse; // Rollback history
            return { text: "Waduh, AI-nya lagi diem nih, nggak ngasih jawaban.", parseMode: null };
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        // Kembalikan history ke state sebelum request gagal
        chatHistories[chatId] = historyBeforeResponse;
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI-nya. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            errorMsg = `Error dari AI (${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
            if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah (${modelToUse}) habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && apiError.message.includes("inline data") || apiError.message.includes("image")) {
                 errorMsg = `Waduh ${userName}, sepertinya ada masalah pas ngirim data gambar/file ke AI (${modelToUse}). Ukuran atau formatnya mungkin? Error: ${apiError.message}`;
            } else if (apiError.message && (apiError.message.includes("SAFETY") || apiError.message.includes("blocked"))) {
                 errorMsg = `Maaf ${userName}, permintaanmu diblokir oleh sistem keamanan AI. Coba gunakan kata-kata yang berbeda. (${apiError.message})`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI lagi ada masalah internal nih (${error.response.status}). Coba beberapa saat lagi.`;
        }
        return { text: errorMsg, parseMode: null }; // Selalu kirim tanpa parseMode
    }
}
// --- Akhir Fungsi Gemini (Text & Vision) ---

// --- Fungsi Generate & Edit Gambar dengan Gemini ---
async function generateImageWithGemini(chatId, prompt, userName = 'mas', inputImageBase64 = null, inputImageMimeType = null) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set for image generation.");
        return { error: `Maaf ${userName}, konfigurasi AI untuk gambar belum diatur.` };
    }
    if (!GEMINI_IMAGE_MODEL_NAME) {
        console.error("Gemini Image Model Name is not set.");
        return { error: `Maaf ${userName}, model AI untuk gambar belum ditentukan.` };
    }
    // Cek prompt kosong
    if (!prompt || prompt.trim().length === 0) {
        console.log(`Image generation/editing skipped for chat ${chatId} due to empty prompt.`);
        const action = inputImageBase64 ? 'diedit jadi apa' : 'digambar apa'; // Tentukan aksi berdasarkan input
        const exampleAction = inputImageBase64 ? 'edit tambahkan kacamata hitam' : 'img kucing astronot';
        return { error: `Mau ${action}, ${userName}? Kasih tau dong. Contoh: /${exampleAction}` };
    }

    const modelToUse = GEMINI_IMAGE_MODEL_NAME;
    const apiUrl = `${GEMINI_API_URL_BASE}${modelToUse}:generateContent?key=${GEMINI_API_KEY}`;

    const isEditing = inputImageBase64 && inputImageMimeType; // Tentukan apakah ini request edit
    const logAction = isEditing ? "Editing" : "Generating"; // Untuk logging

    console.log(`Calling Gemini Image API (${modelToUse}) for chat ${chatId}. User: ${userName}. Action: ${logAction}. Prompt: "${prompt}"`);

    // --- Susun bagian 'contents' untuk request API ---
    const requestContents = [];
    // Selalu tambahkan prompt teks terlebih dahulu (instruksi)
    requestContents.push({ text: prompt });

    // Jika ini adalah permintaan edit, tambahkan data gambar input setelah teks prompt
    if (isEditing) {
        if (!inputImageMimeType.startsWith('image/')) {
            console.error(`Invalid input image mime type for editing: ${inputImageMimeType}`);
            return { error: `Waduh ${userName}, format gambar input (${inputImageMimeType}) sepertinya tidak didukung untuk diedit.` };
        }
        requestContents.push({
            inlineData: {
                mimeType: inputImageMimeType, // Harus valid (image/jpeg, image/png, image/webp, dll)
                data: inputImageBase64
            }
        });
        console.log(`Input image provided for editing (MimeType: ${inputImageMimeType})`);
    }
    // --- Akhir penyusunan 'contents' ---

    // Buat request body lengkap
    const requestBody = {
        contents: requestContents, // Gunakan array 'contents' yang sudah dibuat
        generationConfig: {
            responseModalities: ["IMAGE"], // Minta HANYA gambar sebagai output utama
            // responseMimeType: "image/png" // Opsional: Paksa output PNG jika diinginkan
            temperature: 0.7, // Suhu untuk kreativitas (sesuaikan)
            // numberOfImages: 1 // Minta 1 gambar saja (defaultnya bisa beda)
        },
         safetySettings: [ // Konfigurasi Keamanan yang lebih ketat untuk gambar
             { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_LOW_AND_ABOVE' }, // Lebih sensitif
             { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
             { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
             { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
         ]
    };

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 180000 // Timeout 3 menit untuk generate/edit gambar
        });

        const candidate = response.data?.candidates?.[0];

        if (!candidate) {
             console.error(`Gemini Image response missing candidates for chat ${chatId}. Action: ${logAction}.`, JSON.stringify(response.data, null, 2));
             return { error: `Waduh ${userName}, AI nggak ngasih hasil gambar (${logAction}) nih. Coba lagi ya.` };
        }

        // Cek finishReason
        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            console.warn(`Gemini Image response for chat ${chatId} (Action: ${logAction}) finished with reason: ${candidate.finishReason}. Checking for partial content or safety block.`);
            // Coba cari data gambar meskipun finish reason aneh (misal 'SAFETY')
            const imagePart = candidate.content?.parts?.find(part => part.inlineData);
            if (imagePart?.inlineData?.data && imagePart.inlineData.mimeType) {
                 // Kadang gambar tetap ada walau ada safety warning
                 console.log(`Image found despite finish reason ${candidate.finishReason} for chat ${chatId}. Proceeding.`);
                 return {
                     base64Data: imagePart.inlineData.data,
                     mimeType: imagePart.inlineData.mimeType,
                     textFallback: `*(Gambar berhasil ${isEditing ? 'diedit' : 'dibuat'}, tapi ada peringatan: ${candidate.finishReason})*`
                 };
            } else {
                 // Jika benar-benar diblokir karena safety atau alasan lain
                 console.error(`Gemini Image ${logAction} blocked or failed for chat ${chatId}. Reason: ${candidate.finishReason}`);
                 const safetyRatings = candidate.safetyRatings ? ` (${candidate.safetyRatings.map(r => r.category + ':'+r.probability).join(', ')})` : '';
                 const errorReason = isEditing ? "diedit karena kontennya mungkin tidak aman atau ada masalah lain" : "dibuat karena kontennya mungkin tidak aman atau ada masalah lain";
                 return { error: `Waduh ${userName}, gambarnya nggak bisa ${errorReason} (Alasan: ${candidate.finishReason}${safetyRatings}). Coba instruksi/prompt yang berbeda ya.` };
            }
        }

        // Jika finishReason 'STOP', cari data gambar di parts
        const imagePart = candidate.content?.parts?.find(part => part.inlineData);

        if (imagePart?.inlineData?.data && imagePart?.inlineData?.mimeType) {
            console.log(`Image successfully ${isEditing ? 'edited' : 'generated'} for chat ${chatId}. MimeType: ${imagePart.inlineData.mimeType}`);
            // Model image generation biasanya tidak menghasilkan teks bersamaan (kecuali diminta khusus)
            // const textPart = candidate.content?.parts?.find(part => part.text);
            // const textFallback = textPart ? stripMarkdown(textPart.text) : null;

            return {
                base64Data: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType,
                textFallback: null // Biasanya tidak ada teks fallback dari model image-only
            };
        } else {
             // Jika tidak ada gambar sama sekali di respons yang sukses
             console.error(`Gemini Image response format unexpected or missing image data for chat ${chatId} (Action: ${logAction}).`, JSON.stringify(response.data, null, 2));
             // Mungkin API mengembalikan teks error?
             const textPart = candidate.content?.parts?.find(part => part.text);
             if (textPart?.text) {
                 console.warn(`Gemini Image API (${modelToUse}) returned text instead of image for chat ${chatId} (Action: ${logAction}): "${textPart.text.substring(0,100)}..."`);
                 const errorReason = isEditing ? "hasil editnya malah teks, bukan gambar" : "malah ngasih teks, bukan gambar";
                 return { error: `Hmm ${userName}, AI-nya ${errorReason}. Mungkin instruksinya kurang jelas atau ada batasan lain?\n\nPesan AI: ${stripMarkdown(textPart.text)}` };
             } else {
                 return { error: `Waduh ${userName}, ada error pas ${isEditing ? 'ngedit' : 'bikin'} gambarnya (data gambar nggak ditemukan di respons). Coba lagi.` };
             }
        }

    } catch (error) {
        console.error(`Error calling Gemini Image API (${modelToUse}) for chat ${chatId} (Action: ${logAction}):`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ${isEditing ? 'ngedit' : 'bikin'} gambar pake AI. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI ${isEditing ? 'ngedit' : 'bikin'} gambarnya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan minta ${isEditing ? 'edit' : 'gambar'} nih kayaknya, coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            // Perbaiki pesan error agar lebih informatif
            errorMsg = `Error dari AI Gambar (${logAction}) - ${apiError.code || error.response.status}: ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
             if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah ${isEditing ? 'edit' : 'bikin'} gambar (${modelToUse}) habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && (apiError.message.includes("Request payload size") || apiError.message.includes("too large"))) {
                 errorMsg = `Waduh ${userName}, instruksi ${isEditing ? 'edit' : 'buat'} gambarnya kepanjangan atau gambar inputnya terlalu besar (>4MB?). Coba dipersingkat atau pakai gambar lebih kecil.`;
            } else if (apiError.message && apiError.message.includes("response modalities")) {
                 errorMsg = `Waduh ${userName}, model AI (${modelToUse}) ini sepertinya nggak bisa ${isEditing ? 'edit' : 'generate'} gambar sesuai permintaan (konfigurasi salah?). Error: ${apiError.message}`;
            } else if (apiError.message && (apiError.message.includes("SAFETY") || apiError.message.includes("prompt was blocked") || apiError.message.includes("filtered"))) {
                errorMsg = `Maaf ${userName}, ${isEditing ? 'editan' : 'gambar'}mu ditolak karena alasan keamanan/konten (SAFETY). Coba instruksi/prompt yang lebih aman ya.`;
            } else if (apiError.message && apiError.message.includes("inline data") || apiError.message.includes("image format")) {
                 errorMsg = `Waduh ${userName}, sepertinya ada masalah pas ngirim data gambar input ke AI untuk ${isEditing ? 'diedit' : 'diproses'}. Ukuran atau formatnya (${inputImageMimeType}) mungkin tidak didukung? Error: ${apiError.message}`;
            } else if (apiError.message && apiError.message.includes("invalid argument")) {
                 errorMsg = `Waduh ${userName}, ada argumen yang salah saat minta ${isEditing ? 'edit' : 'generate'} gambar. Mungkin format prompt atau konfigurasinya? Error: ${apiError.message}`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI Gambar (${modelToUse}) lagi ada masalah internal nih (${error.response.status}). Coba beberapa saat lagi.`;
        }
        return { error: errorMsg };
    }
}
// --- Akhir Fungsi generateImageWithGemini ---


// --- Handler Utama Vercel ---
module.exports = async (req, res) => {
    // Cek metode request
    if (req.method !== 'POST') {
        console.log('Received non-POST request');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
    // Cek body request
    if (!req.body || typeof req.body !== 'object') {
        console.log('Received invalid or empty request body.');
        // Kirim 200 OK agar Telegram tidak retry terus
        return res.status(200).send('OK - Invalid body');
    }

    // Log request body (hati-hati jika ada data sensitif)
    // console.log('Received update:', JSON.stringify(req.body, null, 2));
    const update = req.body;

    // Proses hanya jika update adalah message dan memiliki struktur dasar
    if (update.message && update.message.chat && update.message.from) {
        const chatId = update.message.chat.id;
        const message = update.message;
        const messageText = (message.text || message.caption || "").trim(); // Ambil juga dari caption
        const chatType = message.chat.type; // 'private', 'group', 'supergroup', 'channel'
        const messageId = message.message_id;
        const userId = message.from.id;
        const username = message.from.username; // Bisa undefined
        const firstName = message.from.first_name;
        const repliedToMessage = message.reply_to_message; // Pesan yang dibalas (jika ada)

        // Dapatkan nama panggilan user
        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`; // Nama untuk konteks AI
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu'; // Nama untuk sapaan bot

        // State flags
        let shouldProcessAI = false;    // Untuk text/vision/grounding
        let shouldGenerateImage = false; // Untuk generate gambar baru
        let shouldEditImage = false;     // Untuk edit gambar via reply
        let promptForAI = "";           // Teks prompt untuk AI/Image model
        let messageIdToReply = messageId; // ID pesan yang akan dibalas
        let enableGrounding = false;    // Aktifkan Google Search?
        let triggerWordUsed = null;     // Kata trigger yang memicu aksi
        let imageBase64 = null;         // Data base64 gambar untuk Vision
        let imageMimeType = null;       // Mime type gambar untuk Vision
        let inputImageBase64 = null;    // Data base64 gambar INPUT untuk Edit
        let inputImageMimeType = null;  // Mime type gambar INPUT untuk Edit

        const lowerCaseText = messageText.toLowerCase();
        const BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        // Daftar trigger (buat case-insensitive dengan lowerCaseText)
        const chatTriggers = ['/chat ', 'lele ', 'le ', 'tanya '];
        const groundingTriggers = ['/info ', 'inpo ', 'kabar ', '/po '];
        const imageTriggers = ['/img ', 'img ', 'buat ', 'gambar '];
        const editTriggers = ['/edit ', 'edit ']; // Trigger untuk edit gambar

        // --- Prioritas 1: Cek Perintah Edit/Vision dari Reply ke Foto ---
        if (repliedToMessage?.photo?.length > 0) {
            console.log(`Detected reply to photo message ${repliedToMessage.message_id} by ${nameForAIContext} (${userId}). Checking edit/vision triggers...`);
            let editTriggerFound = false;
            let visionTriggerFound = false; // Tambahkan flag untuk vision

            // Cek trigger EDIT terlebih dahulu
            for (const trigger of editTriggers) {
                if (lowerCaseText.startsWith(trigger)) {
                    triggerWordUsed = trigger.trim();
                    promptForAI = messageText.substring(trigger.length).trim();
                    if (promptForAI) {
                        console.log(`Processing IMAGE EDIT request (Trigger: '${triggerWordUsed}') for photo ${repliedToMessage.message_id} from ${nameForAIContext} (${userId})`);
                        try {
                            // Kirim aksi 'upload_photo' karena outputnya foto
                            await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'upload_photo' });

                            // Ambil data gambar dari pesan yang dibalas (resolusi tertinggi)
                            const photo = repliedToMessage.photo.sort((a,b) => b.width * b.height - a.width * a.height)[0];
                            const fileId = photo.file_id;
                            console.log(`Getting file path for input image file_id: ${fileId}`);
                            const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                            const filePath = getFileResponse.data?.result?.file_path;
                            if (!filePath) { throw new Error('Input image file path not found.'); }
                            console.log(`Got input image file path: ${filePath}`);
                            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                            console.log(`Downloading input image from: ${fileUrl}`);
                            const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 }); // Timeout 30s download
                            inputImageBase64 = Buffer.from(imageResponse.data).toString('base64'); // Simpan ke variabel input

                            // Tentukan MimeType berdasarkan ekstensi file
                            const fileExtension = filePath.split('.').pop().toLowerCase();
                            switch (fileExtension) {
                                case 'png': inputImageMimeType = 'image/png'; break;
                                case 'webp': inputImageMimeType = 'image/webp'; break;
                                case 'jpg':
                                case 'jpeg': inputImageMimeType = 'image/jpeg'; break;
                                default:
                                    // Jika ekstensi tidak dikenal, coba tebak dari awal header (kurang handal)
                                    const header = imageResponse.data.slice(0, 4).toString('hex');
                                    if (header.startsWith('89504e47')) inputImageMimeType = 'image/png';
                                    else if (header.startsWith('ffd8ffe0') || header.startsWith('ffd8ffe1') || header.startsWith('ffd8ffe2')) inputImageMimeType = 'image/jpeg';
                                    else if (header.startsWith('52494646')) inputImageMimeType = 'image/webp'; // RIFF -> WebP?
                                    else {
                                        console.warn(`Unknown file extension '${fileExtension}' and cannot determine mime type from header for input image. Defaulting to jpeg.`);
                                        inputImageMimeType = 'image/jpeg'; // Default jika tidak bisa ditentukan
                                    }
                            }

                            console.log(`Input image downloaded (${(inputImageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${inputImageMimeType}`);
                            shouldEditImage = true; // <-- Set state edit
                            messageIdToReply = messageId; // Balas ke pesan trigger edit

                        } catch (error) {
                            console.error(`Error fetching/processing input image for edit request (file_id: ${fileId}):`, error.message);
                            await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil gambar yang mau diedit nih. Coba lagi ya.\nError: ${error.message}`, messageId);
                            shouldEditImage = false; // Gagal, jangan proses edit
                        }
                    } else {
                        await sendMessage(chatId, `Mau diedit jadi apa, ${nameForBotGreeting}? Kasih instruksinya dong. Contoh: ${trigger} tambahkan topi santa`, messageId);
                        shouldEditImage = false; // Prompt kosong, jangan proses
                    }
                    editTriggerFound = true;
                    break; // Hentikan loop jika trigger edit ditemukan
                }
            }

            // Jika BUKAN trigger edit, baru cek trigger VISION (chat/lele/dll)
            if (!editTriggerFound && messageText) {
                 for (const trigger of chatTriggers) {
                     if (lowerCaseText.startsWith(trigger)) {
                         visionTriggerFound = true; // Set flag vision
                         triggerWordUsed = `vision_${trigger.trim()}`;
                         promptForAI = messageText.substring(trigger.length).trim();
                         console.log(`Processing VISION request (Trigger: '${trigger.trim()}') for photo ${repliedToMessage.message_id} from ${nameForAIContext} (${userId})`);

                         // Logika ambil gambar untuk VISION (pakai variabel imageBase64 biasa)
                         try {
                             await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' }); // Aksi 'typing' untuk vision
                             const photo = repliedToMessage.photo.sort((a,b) => b.width * b.height - a.width * a.height)[0];
                             const fileId = photo.file_id;
                             console.log(`Getting file path for vision file_id: ${fileId}`);
                             const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                             const filePath = getFileResponse.data?.result?.file_path;
                             if (!filePath) { throw new Error('File path not found for vision image.'); }
                             console.log(`Got vision file path: ${filePath}`);
                             const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                             console.log(`Downloading image for vision from: ${fileUrl}`);
                             const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
                             imageBase64 = Buffer.from(imageResponse.data).toString('base64'); // Pakai variabel imageBase64

                            // Tentukan MimeType untuk vision (sama seperti edit)
                            const fileExtension = filePath.split('.').pop().toLowerCase();
                            switch (fileExtension) {
                                case 'png': imageMimeType = 'image/png'; break;
                                case 'webp': imageMimeType = 'image/webp'; break;
                                case 'jpg': case 'jpeg': imageMimeType = 'image/jpeg'; break;
                                default:
                                    const header = imageResponse.data.slice(0, 4).toString('hex');
                                    if (header.startsWith('89504e47')) imageMimeType = 'image/png';
                                    else if (header.startsWith('ffd8ffe0') || header.startsWith('ffd8ffe1') || header.startsWith('ffd8ffe2')) imageMimeType = 'image/jpeg';
                                    else if (header.startsWith('52494646')) imageMimeType = 'image/webp';
                                    else {
                                         console.warn(`Unknown file extension '${fileExtension}' for vision image. Defaulting to jpeg.`);
                                         imageMimeType = 'image/jpeg';
                                    }
                            }

                             console.log(`Image downloaded for vision (${(imageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${imageMimeType}`);
                             shouldProcessAI = true; // Set state proses AI (vision)
                             enableGrounding = false; // Grounding tidak berlaku untuk vision
                             messageIdToReply = messageId; // Balas ke pesan trigger vision

                         } catch (error) {
                             console.error(`Error fetching/processing image for vision request (file_id: ${fileId}):`, error.message);
                             await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil/proses gambarnya nih buat dijelasin. Coba lagi ya.\nError: ${error.message}`, messageId);
                             shouldProcessAI = false; // Gagal, jangan proses
                         }
                         break; // Hentikan loop chat trigger jika vision ditemukan
                     }
                 }
                 // Log jika reply ke foto tapi bukan trigger edit/vision yang dikenali
                 if (!visionTriggerFound && !editTriggerFound && messageText) {
                     console.log(`Ignoring reply to photo from ${nameForAIContext} (${userId}) because text does not start with a valid edit or vision trigger.`);
                 }
            }
        }

        // --- Prioritas 2 & 3: Cek trigger lain HANYA JIKA BUKAN EDIT atau VISION dari reply foto ---
        if (!shouldEditImage && !shouldProcessAI) {

            // Cek Perintah /clear history
             if (lowerCaseText === '/clear') {
                if (chatHistories[chatId]) {
                    delete chatHistories[chatId];
                    await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan! Kita mulai dari awal ya.`, messageIdToReply);
                    console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
                } else {
                    await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history obrolan buat dihapus di chat ini.`, messageIdToReply);
                }
                return res.status(200).send('OK'); // Hentikan proses lebih lanjut
            }

            // Cek trigger image generation (/img, img, dll)
            let imageTriggerFound = false;
            for (const trigger of imageTriggers) {
                if (lowerCaseText.startsWith(trigger)) {
                    triggerWordUsed = trigger.trim();
                    promptForAI = messageText.substring(trigger.length).trim();
                    if (promptForAI) {
                        shouldGenerateImage = true;
                        console.log(`Processing IMAGE GENERATION request (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId})`);
                    } else {
                        await sendMessage(chatId, `Mau ${triggerWordUsed} apa, ${nameForBotGreeting}? Kasih tau dong. Contoh: ${trigger} pemandangan senja di pantai`, messageIdToReply);
                        shouldGenerateImage = false; // Jangan proses jika prompt kosong
                    }
                    imageTriggerFound = true;
                    break; // Hentikan loop jika trigger gambar ditemukan
                }
            }

            // Jika BUKAN image generation, baru cek trigger text/grounding/dll
            if (!shouldGenerateImage) {
                // Cek trigger grounding (/info, inpo, dll)
                enableGrounding = false;
                let groundingTriggerFound = false;
                for (const trigger of groundingTriggers) {
                    if (lowerCaseText.startsWith(trigger)) {
                        triggerWordUsed = trigger.trim();
                        promptForAI = messageText.substring(trigger.length).trim();
                        if (promptForAI) {
                            shouldProcessAI = true; // Proses sebagai AI text
                            enableGrounding = true; // Aktifkan grounding
                            groundingTriggerFound = true;
                            console.log(`Processing TEXT message ${messageId} WITH grounding (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId})`);
                        } else {
                            await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari ${triggerWordUsed} apa? Contoh: ${triggerWordUsed} berita terkini tentang AI`, messageIdToReply);
                            shouldProcessAI = false; // Jangan proses jika prompt kosong
                        }
                        break; // Hentikan loop jika trigger grounding ditemukan
                    }
                }

                // Jika BUKAN grounding, cek trigger chat biasa atau kondisi lain
                if (!groundingTriggerFound) {
                    // Logika untuk Private Chat
                    if (chatType === 'private') {
                         if (messageText) { // Hanya proses jika ada teks
                            shouldProcessAI = true;
                            promptForAI = messageText;
                            triggerWordUsed = 'private_chat';
                            enableGrounding = false; // Default grounding nonaktif di private

                            // Deteksi implisit untuk grounding di private
                            if (lowerCaseText.startsWith("cari info ") || lowerCaseText.startsWith("inpo ") || lowerCaseText.startsWith("berita ") || lowerCaseText.startsWith("apa itu ")) {
                                 const query = messageText.substring(messageText.indexOf(" ") + 1).trim();
                                 if(query) {
                                    promptForAI = query; // Gunakan query setelah kata kunci
                                    enableGrounding = true; // Aktifkan grounding
                                    triggerWordUsed = 'private_grounding_implicit';
                                    console.log(`Processing private message ${messageId} WITH grounding (Implicit trigger) from ${nameForAIContext} (${userId})`);
                                 } else {
                                     // Jika hanya "cari info", anggap sebagai chat biasa
                                     console.log(`Processing private message ${messageId} as regular chat (Implicit grounding trigger without query) from ${nameForAIContext} (${userId})`);
                                 }
                            } else {
                                 // Chat biasa di private
                                 console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
                            }
                        } else {
                             // Abaikan pesan tanpa teks di private (misal stiker, dll)
                             console.log(`Ignoring empty private message ${messageId} from ${nameForAIContext} (${userId})`);
                             shouldProcessAI = false;
                        }
                    }
                    // Logika untuk Group/Supergroup Chat
                    else if (chatType === 'group' || chatType === 'supergroup') {
                        let textTriggerFound = false;
                        // Cek trigger chat eksplisit (/chat, lele, dll)
                        if (messageText) {
                             for (const trigger of chatTriggers) {
                                if (lowerCaseText.startsWith(trigger)) {
                                    triggerWordUsed = trigger.trim();
                                    promptForAI = messageText.substring(trigger.length).trim();
                                    if (promptForAI){
                                         textTriggerFound = true;
                                    } else {
                                        // Jika trigger ada tapi prompt kosong
                                        await sendMessage(chatId, `Iya ${nameForBotGreeting}? Mau ${triggerWordUsed} apa nih? Contoh: ${triggerWordUsed} jelaskan soal black hole`, messageIdToReply);
                                        shouldProcessAI = false; // Jangan proses
                                    }
                                    break; // Hentikan loop jika trigger chat ditemukan
                                }
                            }
                        }

                        // Cek jika membalas pesan bot (untuk melanjutkan percakapan)
                        // Pastikan bot token ada dan pesan yg dibalas dari bot ini, dan bukan foto
                         if (!textTriggerFound && BOT_USER_ID && repliedToMessage?.from?.id === BOT_USER_ID && repliedToMessage.text && !repliedToMessage.photo) {
                              if(messageText){ // Hanya proses jika balasan user ada teksnya
                                   triggerWordUsed = 'reply_to_bot_text';
                                   const botPreviousText = repliedToMessage.text;
                                   const userReplyText = messageText;

                                   // Coba cari giliran terakhir bot di history
                                   let history = chatHistories[chatId] || [];
                                   const lastBotTurnIndex = history.map(h => h.role).lastIndexOf('model');

                                   // Periksa apakah teks bot yang dibalas cocok (atau bagian awalnya cocok) dengan history
                                   if(lastBotTurnIndex !== -1 && history[lastBotTurnIndex].parts[0].text.includes(botPreviousText.substring(0, 50))) {
                                        promptForAI = userReplyText; // Gunakan balasan user sebagai prompt baru
                                        console.log(`Continuing conversation based on reply to bot message ${repliedToMessage.message_id}`);
                                        textTriggerFound = true; // Anggap sebagai trigger teks
                                        messageIdToReply = messageId; // Balas ke pesan user
                                   } else {
                                        // Jika history tidak cocok (atau kosong), buat konteks manual
                                        console.warn(`Could not find matching bot turn in history for reply ${repliedToMessage.message_id}. Creating manual context.`);
                                        // Format prompt agar AI tahu konteksnya
                                        promptForAI = `Ini adalah respons saya sebelumnya: "${botPreviousText}"\n\nSekarang tanggapi ini dari ${nameForAIContext}: "${userReplyText}"`;
                                        // Reset history jika tidak cocok untuk menghindari kebingungan AI
                                        if(history.length > 2) { // Jangan reset jika history baru mulai
                                            const systemPrompts = history.filter(h => h.role === 'system');
                                            chatHistories[chatId] = systemPrompts; // Hanya sisakan system prompts
                                            console.warn(`Resetting conversation history for chat ${chatId} due to potential context mismatch in reply.`);
                                        }
                                        textTriggerFound = true;
                                        messageIdToReply = messageId; // Balas ke pesan user
                                   }
                              } else {
                                   console.log(`Ignoring reply to bot message ${repliedToMessage.message_id} because user reply text is empty.`);
                              }
                         }

                        // Jika trigger teks ditemukan (baik eksplisit atau reply ke bot)
                        if (textTriggerFound && promptForAI) {
                             // Cek apakah trigger teks ini juga membalas pesan user lain
                             if (triggerWordUsed !== 'reply_to_bot_text' && repliedToMessage && repliedToMessage.text && repliedToMessage.from?.id !== BOT_USER_ID) {
                                  const repliedText = repliedToMessage.text;
                                  let originalSenderName = 'seseorang';
                                  const repliedFrom = repliedToMessage.from;
                                  if (repliedFrom) {
                                      const repliedUsername = repliedFrom.username ? repliedFrom.username.toLowerCase() : null;
                                      const repliedNickname = repliedUsername ? userNicknames[repliedUsername] : null;
                                      originalSenderName = repliedNickname || repliedFrom.first_name || (repliedFrom.username ? `@${repliedFrom.username}` : `User ${repliedFrom.id}`);
                                  }
                                  // Tambahkan konteks pesan yang dibalas ke prompt
                                  promptForAI = `Berikut adalah pesan dari ${originalSenderName} yang saya balas: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya (${nameForAIContext}) berikut: "${promptForAI}"`;
                                  console.log(`Added context from replied text message ${repliedToMessage.message_id} to the prompt.`);
                                  messageIdToReply = messageId; // Balas ke pesan trigger, bukan pesan yg dibalas user
                              }

                            shouldProcessAI = true; // Proses sebagai AI text
                            enableGrounding = false; // Grounding nonaktif untuk chat biasa
                            console.log(`Trigger TEXT '${triggerWordUsed}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
                        } else if (!textTriggerFound && messageText) {
                             // Jika ada teks tapi bukan trigger dan bukan reply ke bot
                             console.log(`Ignoring non-trigger text message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
                             shouldProcessAI = false;
                         } else if (!messageText) {
                             // Abaikan pesan tanpa teks di grup (misal stiker, join/leave notif)
                             console.log(`Ignoring message ${messageId} in group chat ${chatId} because it has no text content.`);
                             shouldProcessAI = false;
                         }
                    }
                     // Abaikan tipe chat lain (misal channel) atau kondisi tak terduga
                     else {
                        console.log(`Ignoring message from unsupported chat type: ${chatType} or unhandled condition.`);
                        shouldProcessAI = false;
                    }
                }
            }
        }


        // --- Bagian Eksekusi (setelah semua trigger dicek) ---
        const effectivePromptLength = (promptForAI || "").length + (imageBase64 ? imageBase64.length : 0) + (inputImageBase64 ? inputImageBase64.length : 0); // Hitung total ukuran prompt + gambar
        // Perkiraan batas aman untuk API Gemini (terutama dengan gambar base64)
        // Ukuran base64 sekitar 4/3 ukuran asli. Batas API mungkin sekitar 4-8MB. Kita set konservatif.
        const MAX_EFFECTIVE_PROMPT_BYTES = 4 * 1024 * 1024; // 4 MB

        console.log(`Effective prompt/image size: ${effectivePromptLength} bytes (Limit: ${MAX_EFFECTIVE_PROMPT_BYTES})`);

        if (effectivePromptLength > MAX_EFFECTIVE_PROMPT_BYTES) {
             // Beri pesan error jika ukuran total terlalu besar
             await sendMessage(chatId, `Waduh ${nameForBotGreeting}, permintaannya (${triggerWordUsed || 'tidak diketahui'}) terlalu besar nih (total prompt/gambar > ${(MAX_EFFECTIVE_PROMPT_BYTES / 1024 / 1024).toFixed(1)} MB). Coba dipersingkat atau pakai gambar lebih kecil ya.`, messageIdToReply);
        }
        // Urutan Prioritas Eksekusi: Edit > AI (Vision/Text) > Generate
        else if (shouldEditImage) { // 1. Proses Edit Gambar
            console.log(`Executing image edit for message ${messageId} triggered by ${triggerWordUsed}`);
             // Aksi upload_photo sudah dikirim saat deteksi trigger

             const imageResult = await generateImageWithGemini(
                 chatId,
                 promptForAI,
                 nameForAIContext,
                 inputImageBase64,      // <-- Kirim gambar input
                 inputImageMimeType     // <-- Kirim mimeType gambar input
             );

             if (imageResult.base64Data && imageResult.mimeType) {
                 const caption = `neh hasil editan mu pake ${triggerWordUsed} 🙏😭`;
                 if(imageResult.textFallback) caption += `\n\n${imageResult.textFallback}`; // Tambahkan fallback teks jika ada
                 await sendPhotoFromBase64(chatId, imageResult.base64Data, imageResult.mimeType, caption, messageIdToReply);
             } else {
                 // Kirim pesan error dari fungsi generate/edit
                 await sendMessage(chatId, imageResult.error || `Waduh ${nameForBotGreeting}, gagal ${triggerWordUsed} gambarnya nih, coba lagi nanti ya. (Error tidak diketahui)`, messageIdToReply);
             }
        }
        else if (shouldProcessAI) { // 2. Proses AI (Vision / Text / Grounding)
             console.log(`Executing AI processing (Vision/Text/Grounding) for message ${messageId} triggered by ${triggerWordUsed}`);
             // Validasi lagi sebelum panggil API (seharusnya tidak perlu jika logika di atas benar)
             if (!promptForAI && !imageBase64) {
                  console.warn(`shouldProcessAI is true but both prompt and image are missing for chat ${chatId}, message ${messageId}. Skipping execution.`);
             } else {
                 // Kirim 'typing' hanya jika bukan vision (vision sudah ada 'typing' saat ambil gambar)
                 if (!imageBase64) {
                     try {
                         await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                     } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }
                 }

                 // Panggil fungsi Gemini untuk text/vision
                 const aiResponseObject = await getGeminiResponse(
                     chatId,
                     promptForAI,
                     nameForAIContext,
                     enableGrounding,
                     imageBase64,      // Ini untuk vision (null jika text)
                     imageMimeType       // Ini untuk vision (null jika text)
                 );
                 // Kirim hasil teks ke Telegram
                 await sendMessage(chatId, aiResponseObject.text, messageIdToReply);
             }
        }
        else if (shouldGenerateImage) { // 3. Proses Generate Gambar Baru
            console.log(`Executing image generation for message ${messageId} triggered by ${triggerWordUsed}`);
            try {
                // Kirim aksi 'upload_photo'
                await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'upload_photo' });
            } catch (actionError) { console.warn("Could not send upload_photo action:", actionError.message); }

            // Panggil fungsi generateImage TANPA gambar input
            const imageResult = await generateImageWithGemini(
                chatId,
                promptForAI,
                nameForAIContext,
                null, // Tidak ada gambar input
                null  // Tidak ada mimeType input
            );

            if (imageResult.base64Data && imageResult.mimeType) {
                 // Caption untuk gambar baru
                 let caption = `📷 Hasil ${triggerWordUsed} untuk "${promptForAI.substring(0, 50)}${promptForAI.length > 50 ? '...' : ''}"`;
                 if(imageResult.textFallback) caption += `\n\n${imageResult.textFallback}`; // Tambahkan fallback teks jika ada
                 caption += `\n\n🙏 Jika aneh/tidak sesuai, coba prompt lain atau /edit ya!`;
                 // Tautan prompt bisa ditambahkan jika relevan
                 // caption += `\n\nBingung prompt? Cek: https://poe.com/prompt-img-lele`;
                 await sendPhotoFromBase64(chatId, imageResult.base64Data, imageResult.mimeType, caption.substring(0, 1024), messageIdToReply);
            } else {
                 // Kirim pesan error dari fungsi generate/edit
                await sendMessage(chatId, imageResult.error || `Waduh ${nameForBotGreeting}, gagal bikin gambarnya nih, coba lagi nanti ya. (Error tidak diketahui)`, messageIdToReply);
            }
        }
        // --- Akhir Bagian Eksekusi ---

    } else if (update.message && update.message.chat) {
        // Update adalah pesan tapi tidak lengkap (misal hanya notif user join/left)
        const chatId = update.message.chat.id;
        console.log(`Ignoring non-text/photo/incomplete message update in chat ${chatId || 'unknown'}`);
    } else if (update.edited_message) {
        // Abaikan pesan yang diedit untuk saat ini
        console.log(`Ignoring edited message update: ${update.edited_message.message_id}`);
    } else if (update.callback_query) {
        // Abaikan callback query dari inline keyboard (jika ada)
        console.log(`Ignoring callback query update: ${update.callback_query.id}`);
    }
    else {
        // Abaikan tipe update lain yang tidak relevan
        console.log('Ignoring update that is not a processable message.');
        // console.log('Ignored Update Body:', JSON.stringify(update, null, 2)); // Debug: lihat update yang diabaikan
    }

    // Selalu kirim status 200 OK ke Telegram agar tidak retry
    res.status(200).send('OK');
};
// --- Akhir Handler Utama Vercel ---