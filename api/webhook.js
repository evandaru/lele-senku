// api/webhook.js
const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_VISION_MODEL_NAME = "gemini-2.0-flash";
const GEMINI_TEXT_MODEL_NAME = "gemini-2.0-flash";
const GEMINI_IMAGE_MODEL_NAME = "gemini-2.0-flash-exp-image-generation";
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
             const fallbackText = text.replace(/[*_`\[\]()]/g, '');
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

// --- Fungsi BARU: sendPhotoFromBase64 ---
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
        const fileName = `generated_image.${mimeType.split('/')[1] || 'png'}`;

        const formData = new FormData();
        formData.append('chat_id', chatId.toString());
        formData.append('photo', imageBuffer, { filename: fileName, contentType: mimeType });
        if (caption) { formData.append('caption', caption.substring(0, 1024)); }
        if (replyToMessageId) { formData.append('reply_to_message_id', replyToMessageId); }

        await axios.post(`${TELEGRAM_API}/sendPhoto`, formData, {
            headers: formData.getHeaders(),
            timeout: 60000
        });
        console.log(`Photo sent successfully to ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));

    } catch (error) {
        console.error(`Error sending photo to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorMsg = `Aduh, maaf banget, gagal ngirim gambarnya nih.`;
        if (error.response?.data?.description) {
            errorMsg += ` (${error.response.data.description})`;
        } else if (error.code === 'ECONNABORTED') {
            errorMsg = `Aduh, kelamaan nih upload gambarnya ke Telegram. Coba lagi nanti.`;
        }
        await sendMessage(chatId, errorMsg, replyToMessageId);
    }
}
// --- Akhir Fungsi sendPhotoFromBase64 ---

// --- Riwayat & Nama Panggilan ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 50;
// --- Akhir Riwayat ---

// --- Fungsi stripMarkdown ---
function stripMarkdown(text) {
    if (!text) return text;

    const originalLines = text.split('\n');
    const processedLines = [];
    const listItemRegex = /^(\s*)(?:[*\-+]|\d+\.)\s+(.*)$/;
    const headerRegex = /^\s*#+\s+/;
    const hrRegex = /^\s*([-*_]){3,}\s*$/;
    const categoryHeaderRegex = /^(\s*)([^:\n]+:)\s*$/;
    const startsWithWhitespaceRegex = /^\s+/;

    for (let i = 0; i < originalLines.length; i++) {
        const line = originalLines[i];
        let processedLine = line;
        let addCheckMark = false;

        if (hrRegex.test(line)) {
            continue;
        }

        processedLine = processedLine.replace(headerRegex, '');
        processedLine = processedLine.replace(/[*_`[\]()]/g, '');
        processedLine = processedLine.replace(/\bhttps?:\/\/\S+/gi, '');

        const listItemMatch = line.match(listItemRegex);
        const categoryHeaderMatch = processedLine.match(categoryHeaderRegex);
        const nextLine = originalLines[i + 1];

        if (listItemMatch) {
            const indent = listItemMatch[1];
            let content = listItemMatch[2];
            content = content.replace(/[*_`[\]()]/g, '').replace(/\bhttps?:\/\/\S+/gi, '');
            processedLine = indent + '✅ ' + content.trim();
            addCheckMark = false;
        } else if (categoryHeaderMatch && !startsWithWhitespaceRegex.test(categoryHeaderMatch[1]) && nextLine && listItemRegex.test(nextLine)) {
            processedLine = processedLine.trim();
            addCheckMark = true;
        } else {
            processedLine = processedLine.trim();
            addCheckMark = false;
        }

        if (addCheckMark && processedLine) {
            processedLine = '✅ ' + processedLine;
        }

        if (processedLine.trim()) {
            processedLines.push(processedLine);
        } else if (processedLines.length > 0 && processedLines[processedLines.length - 1].trim() !== '') {
            processedLines.push('');
        }
    }

    let resultText = processedLines.join('\n');

    resultText = resultText.replace(/ +/g, ' ');
    resultText = resultText.replace(/✅(\S)/g, '✅ $1');
    resultText = resultText.replace(/\n\s*\n/g, '\n\n');
    resultText = resultText.replace(/\n{3,}/g, '\n\n');

    return resultText.trim();
}

// --- Akhir Fungsi stripMarkdown ---

// --- Fungsi Panggil Gemini ---
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

    if (history.length === 0) {
        history.push({ role: "system", parts: [{ text: `Pengguna saat ini adalah ${userName}.` }] });
        history.push({ role: "system", parts: [{ "text": systemInstructionText }] });
    }

    const currentUserTurnContent = [];
    if (newUserPrompt) {
        currentUserTurnContent.push({ text: newUserPrompt });
    }
    if (isVisionRequest) {
        currentUserTurnContent.push({
            inlineData: {
                mimeType: imageMimeType,
                data: imageBase64
            }
        });
        if (!newUserPrompt) {
            currentUserTurnContent.unshift({ text: "Describe this image." });
             console.log("No text prompt provided with image, using default 'Describe this image.'");
        }
    }
    history.push({ role: "user", parts: currentUserTurnContent });

     const currentHistoryLength = history.reduce((acc, turn) => acc + JSON.stringify(turn).length, 0);
     const MAX_HISTORY_SIZE_BYTES = 50000;

     if (history.length > MAX_HISTORY_LENGTH || currentHistoryLength > MAX_HISTORY_SIZE_BYTES) {
        console.warn(`History for chat ${chatId} exceeding limits (Length: ${history.length}/${MAX_HISTORY_LENGTH}, Size: ${currentHistoryLength}/${MAX_HISTORY_SIZE_BYTES}), trimming...`);
        const systemPromptsCount = history.filter(h => h.role === 'system').length;
        const conversationTurns = (history.length - systemPromptsCount);
        const turnsToKeep = isVisionRequest ? 3 : 5;

        if (conversationTurns > turnsToKeep * 2) {
            const itemsToRemove = Math.max(0, conversationTurns - (turnsToKeep * 2));
             if (itemsToRemove > 0) {
                 history.splice(systemPromptsCount, itemsToRemove);
                 console.log(`Trimmed ${itemsToRemove} items (turns) from history for chat ${chatId}`);
             }
        }
     }
    // --- Akhir Pemotongan History ---

    const historyBeforeResponse = [...history];

    console.log(`Calling Gemini API (${modelToUse}) for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt || '(Image only)'}". Grounding: ${enableGrounding}`);

    const requestBody = {
        systemInstruction: {
            role: "system",
            parts: history.filter(h => h.role === 'system').flatMap(h => h.parts)
        },
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 0.8,
            topP: 0.9,
        },
    };

    if (enableGrounding && !isVisionRequest) {
        requestBody.tools = [{'google_search': {}}];
        console.log("Grounding enabled (google_search) for this text request.");
    } else if (enableGrounding && isVisionRequest) {
        console.warn("Grounding was requested but disabled because this is a vision request.");
        enableGrounding = false;
    }

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 120000
        });

        const candidate = response.data?.candidates?.[0];
        let aiResponseText = '';

        if (!candidate) {
             console.error("Gemini response missing candidates.", JSON.stringify(response.data, null, 2));
             chatHistories[chatId] = historyBeforeResponse;
             return { text: `Waduh ${userName}, AI-nya nggak ngasih respon nih kali ini. Coba lagi ya.`, parseMode: null };
        }

        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
             console.warn(`Gemini response finished with reason: ${candidate.finishReason}. Content may be incomplete or blocked.`);
             aiResponseText = candidate.content?.parts?.[0]?.text || '';
             if (!aiResponseText) {
                 chatHistories[chatId] = historyBeforeResponse;
                 return { text: `Maaf ${userName}, respons AI diblokir karena alasan keamanan (${candidate.finishReason}). Coba prompt yang berbeda ya.`, parseMode: null };
             }
             aiResponseText += `\n\n(Respons mungkin tidak lengkap karena: ${candidate.finishReason})`;
        } else {
             aiResponseText = candidate.content?.parts?.[0]?.text;
        }


        const groundingAttributions = (enableGrounding && candidate.citationMetadata?.citationSources) ? candidate.citationMetadata.citationSources : null;

        if (aiResponseText) {
            console.log("Original AI text received:", aiResponseText.substring(0,100) + "...");
            aiResponseText = stripMarkdown(aiResponseText);
            console.log("AI text after stripping Markdown:", aiResponseText.substring(0,100) + "...");

            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history;

            let finalResponseText = aiResponseText;
            let parseMode = null;

            if (groundingAttributions && groundingAttributions.length > 0) {
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

            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found in response.");
            }

            return { text: finalResponseText.trim(), parseMode: null };

        } else if (!aiResponseText && isVisionRequest) {
             console.warn("Vision request successful but no text description returned.");
             history.push({ role: "model", parts: [{ text: "(Deskripsi gambar tidak tersedia)" }] });
             chatHistories[chatId] = history;
             return { text: `Hmm ${userName}, AI-nya bisa lihat gambarnya, tapi nggak bisa ngasih deskripsi teksnya nih. Aneh ya.`, parseMode: null };
        } else {
            console.error("Gemini response format unexpected or empty text.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse;
            return { text: "Waduh, AI-nya lagi diem nih, nggak ngasih jawaban.", parseMode: null };
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        chatHistories[chatId] = historyBeforeResponse;
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI-nya. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih kayaknya, coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            errorMsg = `Error dari AI - ${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
            if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && apiError.message.includes("inline data")) {
                 errorMsg = `Waduh ${userName}, sepertinya ada masalah pas ngirim data gambar/file ke AI. Ukuran atau formatnya mungkin? ${apiError.message}`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI lagi ada masalah internal nih. Coba beberapa saat lagi.`;
        }
        return { text: errorMsg, parseMode: null };
    }
}
// --- Akhir Fungsi Gemini ---

// --- Fungsi BARU: generateImageWithGemini ---
// (Tambahkan inputImageBase64 dan inputImageMimeType sebagai parameter)
async function generateImageWithGemini(chatId, prompt, userName = 'mas', inputImageBase64 = null, inputImageMimeType = null) {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set for image generation.");
        return { error: `Maaf ${userName}, konfigurasi AI untuk gambar belum diatur.` };
    }
    if (!GEMINI_IMAGE_MODEL_NAME) {
        console.error("Gemini Image Model Name is not set.");
        return { error: `Maaf ${userName}, model AI untuk gambar belum ditentukan.` };
    }
    if (!prompt || prompt.trim().length === 0) {
        console.log(`Image generation/editing skipped for chat ${chatId} due to empty prompt.`);
        const action = inputImageBase64 ? 'diedit jadi apa' : 'digambar apa';
        const exampleAction = inputImageBase64 ? 'edit tambahkan kacamata hitam' : 'img kucing astronot';
        return { error: `Mau ${action}, ${userName}? Kasih tau dong. Contoh: /${exampleAction}` };
    }

    const modelToUse = GEMINI_IMAGE_MODEL_NAME;
    const apiUrl = `${GEMINI_API_URL_BASE}${modelToUse}:generateContent?key=${GEMINI_API_KEY}`;

    const isEditing = inputImageBase64 && inputImageMimeType;
    const logAction = isEditing ? "Editing" : "Generating";

    console.log(`Calling Gemini Image API (${modelToUse}) for chat ${chatId}. User: ${userName}. Action: ${logAction}. Prompt: "${prompt}"`);

    // --- MODIFIKASI BAGIAN INI ---
    const requestContents = [];
    // Selalu tambahkan prompt teks terlebih dahulu
    requestContents.push({ text: prompt });

    // Jika ini adalah permintaan edit, tambahkan data gambar input
    if (isEditing) {
        requestContents.push({
            inlineData: {
                mimeType: inputImageMimeType,
                data: inputImageBase64
            }
        });
        console.log(`Input image provided for editing (MimeType: ${inputImageMimeType})`);
    }
    // --- AKHIR MODIFIKASI ---

    const requestBody = {
        // --- MODIFIKASI BAGIAN INI ---
        // Gunakan struktur 'contents' yang sudah dibuat
        contents: requestContents,
        // --- AKHIR MODIFIKASI ---
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"], // Pastikan ini ada
            temperature: 0.7,
            // responseMimeType: "image/png" // Opsional, jika ingin memaksakan output PNG
        },
        // safetySettings: [...] // Safety settings example, actual values depend on needs
    };

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 180000 // Mungkin perlu timeout lebih lama untuk edit+generate
        });

        const candidate = response.data?.candidates?.[0];

        if (!candidate) {
             console.error(`Gemini Image response missing candidates for chat ${chatId}. Action: ${logAction}.`, JSON.stringify(response.data, null, 2));
             return { error: `Waduh ${userName}, AI nggak ngasih hasil gambar (${logAction}) nih. Coba lagi ya.` };
        }

        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            console.warn(`Gemini Image response for chat ${chatId} (Action: ${logAction}) finished with reason: ${candidate.finishReason}. Checking for partial content.`);
            const imagePart = candidate.content?.parts?.find(part => part.inlineData);
            if (imagePart?.inlineData?.data) {
                 console.log(`Image found despite finish reason ${candidate.finishReason} for chat ${chatId}. Proceeding.`);
                 return {
                     base64Data: imagePart.inlineData.data,
                     mimeType: imagePart.inlineData.mimeType || 'image/png', // Default ke png jika tidak ada
                     textFallback: `(Gambar berhasil ${isEditing ? 'diedit' : 'dibuat'}, tapi ada peringatan: ${candidate.finishReason})`
                 };
            } else {
                 console.error(`Gemini Image ${logAction} blocked for chat ${chatId}. Reason: ${candidate.finishReason}`);
                 const safetyRatings = candidate.safetyRatings ? ` (${candidate.safetyRatings.map(r => r.category + ':'+r.probability).join(', ')})` : '';
                 // Pesan error sedikit disesuaikan untuk edit vs generate
                 const errorReason = isEditing ? "diedit karena kontennya mungkin tidak aman" : "dibuat karena kontennya mungkin tidak aman";
                 return { error: `Waduh ${userName}, gambarnya nggak bisa ${errorReason}. Coba instruksi/prompt yang berbeda ya.${safetyRatings}` };
            }
        }

        const imagePart = candidate.content?.parts?.find(part => part.inlineData);

        if (imagePart?.inlineData?.data && imagePart?.inlineData?.mimeType) {
            console.log(`Image successfully ${isEditing ? 'edited' : 'generated'} for chat ${chatId}. MimeType: ${imagePart.inlineData.mimeType}`);
            const textPart = candidate.content?.parts?.find(part => part.text);
            const textFallback = textPart ? stripMarkdown(textPart.text) : null;

            return {
                base64Data: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType,
                textFallback: textFallback // Teks tambahan jika ada
            };
        } else {
             const textPart = candidate.content?.parts?.find(part => part.text);
             if (textPart?.text) {
                 console.warn(`Gemini Image API (${modelToUse}) returned text instead of image for chat ${chatId} (Action: ${logAction}): "${textPart.text.substring(0,100)}..."`);
                 // Beri pesan yang lebih relevan jika sedang mengedit
                 const errorReason = isEditing ? "hasil editnya malah teks, bukan gambar" : "malah ngasih teks, bukan gambar";
                 return { error: `Hmm ${userName}, AI-nya ${errorReason}. Mungkin instruksinya kurang jelas atau ada batasan lain?\n\n${stripMarkdown(textPart.text)}` };
             } else {
                console.error(`Gemini Image response format unexpected or missing image data for chat ${chatId} (Action: ${logAction}).`, JSON.stringify(response.data, null, 2));
                return { error: `Waduh ${userName}, ada error pas ${isEditing ? 'ngedit' : 'bikin'} gambarnya (data nggak lengkap). Coba lagi.` };
             }
        }

    } catch (error) {
        // Error handling disamakan saja, sudah cukup generik
        console.error(`Error calling Gemini Image API (${modelToUse}) for chat ${chatId} (Action: ${logAction}):`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ${isEditing ? 'ngedit' : 'bikin'} gambar pake AI. Coba lagi nanti ya.`;
        // ... (sisa error handling sama seperti sebelumnya) ...
         if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI ${isEditing ? 'ngedit' : 'bikin'} gambarnya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan minta ${isEditing ? 'edit' : 'gambar'} nih kayaknya, coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            errorMsg = `Error dari AI Gambar (${logAction}) - ${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
             if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah ${isEditing ? 'edit' : 'bikin'} gambar habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && apiError.message.includes("Request payload size")) {
                 errorMsg = `Waduh ${userName}, instruksi ${isEditing ? 'edit' : 'buat'} gambarnya kepanjangan/gambar inputnya terlalu besar. Coba dipersingkat atau pakai gambar lebih kecil.`;
            } else if (apiError.message && apiError.message.includes("response modalities")) {
                 errorMsg = `Waduh ${userName}, model AI ini sepertinya nggak bisa ${isEditing ? 'edit' : 'generate'} gambar/teks sesuai permintaan. Mungkin modelnya salah? (${apiError.message})`;
            } else if (apiError.message && (apiError.message.includes("SAFETY") || apiError.message.includes("prompt was blocked"))) {
                errorMsg = `Maaf ${userName}, ${isEditing ? 'editan' : 'gambar'}mu ditolak karena alasan keamanan/konten. Coba instruksi/prompt yang lebih aman ya.`;
            } else if (apiError.message && apiError.message.includes("inline data")) {
                 errorMsg = `Waduh ${userName}, sepertinya ada masalah pas ngirim data gambar input ke AI untuk diedit. Ukuran atau formatnya mungkin? (${apiError.message})`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI (${logAction}) lagi ada masalah internal nih. Coba beberapa saat lagi.`;
        }
        return { error: errorMsg };
    }
}
// --- Akhir Fungsi generateImageWithGemini ---
// --- Akhir Fungsi generateImageWithGemini ---

// --- Handler Utama Vercel ---
// --- Handler Utama Vercel ---
module.exports = async (req, res) => {
    // ... (kode awal handler sama) ...

    if (update.message && update.message.chat && update.message.from) {
        const chatId = update.message.chat.id;
        const message = update.message;
        const messageText = (message.text || "").trim();
        const chatType = message.chat.type;
        const messageId = message.message_id;
        const userId = message.from.id;
        const username = message.from.username;
        const firstName = message.from.first_name;
        const repliedToMessage = message.reply_to_message;

        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

        let shouldProcessAI = false;
        let shouldGenerateImage = false;
        let shouldEditImage = false; // <-- TAMBAHKAN STATE INI
        let promptForAI = "";
        let messageIdToReply = messageId;
        let enableGrounding = false;
        let triggerWordUsed = null;
        let imageBase64 = null;
        let imageMimeType = null;
        let inputImageBase64 = null; // <-- TAMBAHKAN INI UNTUK EDIT
        let inputImageMimeType = null;// <-- TAMBAHKAN INI UNTUK EDIT

        const lowerCaseText = messageText.toLowerCase();
        const BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        const chatTriggers = ['/chat ', 'lele ', 'le ', 'tanya '];
        const groundingTriggers = ['/info ', 'inpo ', 'kabar ', '/po '];
        const imageTriggers = ['/img ', 'img ', 'buat ', 'gambar '];
        const editTriggers = ['/edit ', 'edit ']; // <-- TAMBAHKAN TRIGGER EDIT

        // --- TAMBAHAN: Logika Deteksi Edit Gambar ---
        if (repliedToMessage?.photo?.length > 0) {
            console.log(`Detected reply to photo message ${repliedToMessage.message_id} by ${nameForAIContext} (${userId}). Checking edit/vision triggers...`);
            let editTriggerFound = false;
            for (const trigger of editTriggers) {
                if (lowerCaseText.startsWith(trigger)) {
                    triggerWordUsed = trigger.trim();
                    promptForAI = messageText.substring(trigger.length).trim();
                    if (promptForAI) {
                        console.log(`Processing IMAGE EDIT request (Trigger: '${triggerWordUsed}') for photo ${repliedToMessage.message_id} from ${nameForAIContext} (${userId})`);
                        try {
                            // Kirim aksi 'upload_photo' karena outputnya foto
                            await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'upload_photo' });

                            // Ambil data gambar dari pesan yang dibalas (logika sama seperti vision)
                            const photo = repliedToMessage.photo[repliedToMessage.photo.length - 1]; // Ambil resolusi tertinggi
                            const fileId = photo.file_id;
                            console.log(`Getting file path for input image file_id: ${fileId}`);
                            const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                            const filePath = getFileResponse.data?.result?.file_path;
                            if (!filePath) { throw new Error('Input image file path not found.'); }
                            console.log(`Got input image file path: ${filePath}`);
                            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                            console.log(`Downloading input image from: ${fileUrl}`);
                            const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 }); // Timeout download
                            inputImageBase64 = Buffer.from(imageResponse.data).toString('base64'); // Simpan ke variabel input

                            // Tentukan MimeType (logika sama seperti vision)
                            if (filePath.toLowerCase().endsWith('.png')) { inputImageMimeType = 'image/png'; }
                            else if (filePath.toLowerCase().endsWith('.webp')) { inputImageMimeType = 'image/webp'; }
                            // Tambahkan tipe lain jika perlu (gif, bmp tidak didukung Gemini setahu saya)
                            // else if (filePath.toLowerCase().endsWith('.gif')) { inputImageMimeType = 'image/gif'; }
                            else { inputImageMimeType = 'image/jpeg'; } // Default ke JPEG

                            console.log(`Input image downloaded (${(inputImageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${inputImageMimeType}`);
                            shouldEditImage = true; // <-- Set state edit
                            messageIdToReply = messageId; // Balas ke pesan trigger edit

                        } catch (error) {
                            console.error(`Error fetching/processing input image for edit request (file_id: ${fileId}):`, error.message);
                            await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil gambar yang mau diedit nih. Coba lagi ya. Error: ${error.message}`, messageId);
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

            // Jika BUKAN trigger edit, baru cek trigger vision (chat/lele/dll)
            if (!editTriggerFound && messageText) {
                 let visionTriggerFound = false;
                 for (const trigger of chatTriggers) {
                     if (lowerCaseText.startsWith(trigger)) {
                         visionTriggerFound = true;
                         triggerWordUsed = `vision_${trigger.trim()}`;
                         promptForAI = messageText.substring(trigger.length).trim();
                         console.log(`Vision trigger '${trigger.trim()}' found in reply text to photo.`);

                         // Logika ambil gambar untuk VISION (pakai variabel imageBase64 biasa)
                         try {
                             await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                             const photo = repliedToMessage.photo[repliedToMessage.photo.length - 1];
                             const fileId = photo.file_id;
                             console.log(`Getting file path for vision file_id: ${fileId}`);
                             const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                             const filePath = getFileResponse.data?.result?.file_path;
                             if (!filePath) { throw new Error('File path not found.'); }
                             console.log(`Got file path: ${filePath}`);
                             const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                             console.log(`Downloading image for vision from: ${fileUrl}`);
                             const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                             imageBase64 = Buffer.from(imageResponse.data).toString('base64'); // Pakai variabel imageBase64
                             if (filePath.toLowerCase().endsWith('.png')) { imageMimeType = 'image/png'; }
                             else if (filePath.toLowerCase().endsWith('.webp')) { imageMimeType = 'image/webp'; }
                             else { imageMimeType = 'image/jpeg'; }
                             console.log(`Image downloaded for vision (${(imageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${imageMimeType}`);
                             shouldProcessAI = true; // Set state proses AI (vision)
                             enableGrounding = false;
                         } catch (error) {
                             console.error(`Error fetching/processing image for vision request (file_id: ${fileId}):`, error.message);
                             await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil/proses gambarnya nih. Coba lagi ya.`, messageId);
                             shouldProcessAI = false;
                         }
                         break; // Hentikan loop chat trigger
                     }
                 }
                 if (!visionTriggerFound && !editTriggerFound && messageText) { // Hanya log jika bukan trigger edit atau vision
                     console.log(`Ignoring reply to photo from ${nameForAIContext} (${userId}) because text does not start with a valid edit or chat trigger.`);
                 }
            }
        }
        // --- AKHIR TAMBAHAN LOGIKA EDIT ---

        // Lanjutkan ke pengecekan trigger lain HANYA JIKA BUKAN EDIT ATAU VISION DARI REPLY FOTO
        if (!shouldEditImage && !shouldProcessAI) {
            // Cek trigger image generation (/img, img, dll)
            let imageTriggerFound = false;
            for (const trigger of imageTriggers) {
                if (lowerCaseText.startsWith(trigger)) {
                    triggerWordUsed = trigger.trim();
                    promptForAI = messageText.substring(trigger.length).trim();
                    if (promptForAI) {
                        shouldGenerateImage = true;
                        console.log(`Processing IMAGE generation request (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId})`);
                    } else {
                        await sendMessage(chatId, `Mau ${triggerWordUsed} apa, ${nameForBotGreeting}? Kasih tau dong. Contoh: ${triggerWordUsed} pemandangan senja di pantai`, messageIdToReply);
                        shouldGenerateImage = false;
                    }
                    imageTriggerFound = true;
                    break;
                }
            }

            // Jika bukan image generation, baru cek trigger text/grounding/dll
            if (!shouldGenerateImage) {
                // --- SEMUA KODE DARI pengecekan grounding, private chat, reply ke bot, dll PINDAHKAN KE DALAM BLOK INI ---
                // Contoh awal:
                enableGrounding = false;
                let groundingTriggerFound = false;
                for (const trigger of groundingTriggers) {
                     // ... (sisa kode pengecekan grounding) ...
                }

                if (!groundingTriggerFound) {
                    if (chatType === 'private') {
                        // ... (sisa kode private chat) ...
                    } else if (chatType === 'group' || chatType === 'supergroup') {
                        // ... (sisa kode grup, termasuk reply ke bot, reply ke user lain) ...
                    }
                    // ... (sisa kode else if/else untuk tipe chat lain atau kondisi tidak tertangani) ...
                }
                // --- AKHIR PEMINDAHAN KODE ---
            }
        }


        // --- MODIFIKASI BAGIAN EKSEKUSI ---
        const effectivePromptLength = (promptForAI || "").length + (imageBase64 ? imageBase64.length : 0) + (inputImageBase64 ? inputImageBase64.length : 0); // Hitung juga input image
        const MAX_EFFECTIVE_PROMPT = 4 * 1024 * 1024; // Batas sekitar 4MB untuk total input

        console.log(`Effective prompt/image size: ${effectivePromptLength} bytes (Limit: ${MAX_EFFECTIVE_PROMPT})`);

        if (effectivePromptLength > MAX_EFFECTIVE_PROMPT) {
             await sendMessage(chatId, `Waduh ${nameForBotGreeting}, permintaannya (${triggerWordUsed}) terlalu besar nih (prompt/gambar > ${(MAX_EFFECTIVE_PROMPT / 1024 / 1024).toFixed(1)} MB). Coba dipersingkat atau pakai gambar lebih kecil ya.`, messageIdToReply);
        }
        // --- Urutan Pengecekan Eksekusi ---
        else if (shouldEditImage) { // <-- PROSES EDIT DULUAN
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
                 const caption = `neh hasil editan mu pake ${triggerWordUsed} 🙏😭`; // Sesuaikan caption
                 await sendPhotoFromBase64(chatId, imageResult.base64Data, imageResult.mimeType, caption, messageIdToReply);
             } else {
                 await sendMessage(chatId, imageResult.error || `Waduh ${nameForBotGreeting}, gagal ${triggerWordUsed} gambarnya nih, coba lagi nanti ya.`, messageIdToReply);
             }
        }
        else if (shouldProcessAI) { // <-- PROSES VISION/TEXT KEMUDIAN
             console.log(`Executing AI processing (Vision/Text/Grounding) for message ${messageId} triggered by ${triggerWordUsed}`);
             if (!promptForAI && !imageBase64) {
                  console.warn(`shouldProcessAI is true but both prompt and image are missing for chat ${chatId}, message ${messageId}. Skipping.`);
             } else {
                 if (!imageBase64) { // Hanya kirim typing jika bukan vision (karena vision sudah ada chat action)
                     try {
                         await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                     } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }
                 }

                 const aiResponseObject = await getGeminiResponse(
                     chatId,
                     promptForAI,
                     nameForAIContext,
                     enableGrounding,
                     imageBase64,      // Ini untuk vision
                     imageMimeType       // Ini untuk vision
                 );
                 await sendMessage(chatId, aiResponseObject.text, messageIdToReply);
             }
        }
        else if (shouldGenerateImage) { // <-- PROSES GENERATE TERAKHIR
            console.log(`Executing image generation for message ${messageId} triggered by ${triggerWordUsed}`);
            try {
                await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'upload_photo' });
            } catch (actionError) { console.warn("Could not send upload_photo action:", actionError.message); }

            // Panggil generateImage TANPA gambar input
            const imageResult = await generateImageWithGemini(chatId, promptForAI, nameForAIContext, null, null);

            if (imageResult.base64Data && imageResult.mimeType) {
                 const caption = `📷 Jika gambarnya aneh, harap dihapus yaa 🙏😭 \n\nbingung cari prompt? kesini aja https://poe.com/prompt-img-lele`;
                await sendPhotoFromBase64(chatId, imageResult.base64Data, imageResult.mimeType, caption, messageIdToReply);
            } else {
                await sendMessage(chatId, imageResult.error || `Waduh ${nameForBotGreeting}, gagal bikin gambarnya nih, coba lagi nanti ya.`, messageIdToReply);
            }
        }
        // --- Akhir Modifikasi Bagian Eksekusi ---

    } else if (update.message && update.message.chat) {
        // ... (kode penanganan pesan tidak valid sama) ...
    } else {
        // ... (kode penanganan update tidak valid sama) ...
    }

    res.status(200).send('OK');
};

// --- Akhir Handler Utama Vercel ---