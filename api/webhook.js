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
    const lineInfo = originalLines.map(line => ({
        original: line,
        wasListItem: /^\s*([*\-+]|\d+\.)\s/.test(line.trimStart()),
        textWithoutMarker: line.replace(/^\s*([*\-+]|\d+\.)\s*/, '').trim()
    }));

    let baseStrippedText = text;
    baseStrippedText = baseStrippedText.replace(/[*_`]/g, '');
    baseStrippedText = baseStrippedText.replace(/[\[\]]/g, '');
    baseStrippedText = baseStrippedText.replace(/^\s*#+\s+/gm, '');
    baseStrippedText = baseStrippedText.replace(/^\s*([-*_]){3,}\s*$/gm, '');

    const baseStrippedLines = baseStrippedText.split('\n');
    let resultText = "";
    let currentListItemsTexts = [];

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
            if (currentListItemsTexts.length > 0) {
                let joinedList = "";
                if (currentListItemsTexts.length === 1) { joinedList = currentListItemsTexts[0]; }
                else if (currentListItemsTexts.length === 2) { joinedList = currentListItemsTexts.join(" dan "); }
                else { joinedList = currentListItemsTexts.slice(0, -1).join(", ") + " dan " + currentListItemsTexts.slice(-1); }

                if (resultText.length > 0 && !resultText.endsWith('\n\n')) { resultText = resultText.trimEnd() + '\n\n'; }
                resultText += joinedList;
                currentListItemsTexts = [];
            }

            const lineToAdd = currentLineBaseStripped.replace(/^\s*([*\-+]|\d+\.)\s*/, '').trim();
            if (!info.wasListItem && lineToAdd) {
                 if (resultText.length > 0 && !resultText.endsWith('\n\n')) { resultText = resultText.trimEnd() + '\n\n'; }
                 resultText += lineToAdd;
            } else if (!info.wasListItem && resultText.length > 0 && !resultText.endsWith('\n\n') && (!baseStrippedLines[i+1] || /^\s*$/.test(baseStrippedLines[i+1]))) {
                  if (!/^\s*$/.test(currentLineBaseStripped)) {
                    resultText = resultText.trimEnd() + '\n\n';
                  }
            }
        }
    }

    if (currentListItemsTexts.length > 0) {
        let joinedList = "";
        if (currentListItemsTexts.length === 1) { joinedList = currentListItemsTexts[0]; }
        else if (currentListItemsTexts.length === 2) { joinedList = currentListItemsTexts.join(" dan "); }
        else { joinedList = currentListItemsTexts.slice(0, -1).join(", ") + " dan " + currentListItemsTexts.slice(-1); }
        if (resultText.length > 0 && !resultText.endsWith('\n\n')) { resultText = resultText.trimEnd() + '\n\n'; }
        resultText += joinedList;
    }

    resultText = resultText.replace(/ +/g, ' ');
    resultText = resultText.replace(/\n{3,}/g, '\n\n');
    return resultText.trim();
}
// --- Akhir Fungsi stripMarkdown ---

// --- Fungsi Panggil Gemini DIMODIFIKASI ---
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
async function generateImageWithGemini(chatId, prompt, userName = 'mas') {
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set for image generation.");
        return { error: `Maaf ${userName}, konfigurasi AI untuk gambar belum diatur.` };
    }
    if (!GEMINI_IMAGE_MODEL_NAME) {
        console.error("Gemini Image Model Name is not set.");
        return { error: `Maaf ${userName}, model AI untuk gambar belum ditentukan.` };
    }
     if (!prompt || prompt.trim().length === 0) {
        console.log(`Image generation skipped for chat ${chatId} due to empty prompt.`);
        return { error: `Mau gambar apa, ${userName}? Kasih tau dong. Contoh: /img kucing astronot` };
    }

    const modelToUse = GEMINI_IMAGE_MODEL_NAME;
    const apiUrl = `${GEMINI_API_URL_BASE}${modelToUse}:generateContent?key=${GEMINI_API_KEY}`;

    console.log(`Calling Gemini Image API (${modelToUse}) for chat ${chatId}. User: ${userName}. Prompt: "${prompt}"`);

    const requestBody = {
        contents: [{
            role: "user",
            parts: [{ text: prompt }]
        }],
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            temperature: 0.7,
        },
        // safetySettings: [...] // Safety settings example, actual values depend on needs
    };

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 180000
        });

        const candidate = response.data?.candidates?.[0];

        if (!candidate) {
             console.error(`Gemini Image response missing candidates for chat ${chatId}.`, JSON.stringify(response.data, null, 2));
             return { error: `Waduh ${userName}, AI nggak ngasih hasil gambar nih. Coba lagi ya.` };
        }

        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
            console.warn(`Gemini Image response for chat ${chatId} finished with reason: ${candidate.finishReason}. Checking for partial content.`);
            const imagePart = candidate.content?.parts?.find(part => part.inlineData);
            if (imagePart?.inlineData?.data) {
                 console.log(`Image found despite finish reason ${candidate.finishReason} for chat ${chatId}. Proceeding.`);
                 return {
                     base64Data: imagePart.inlineData.data,
                     mimeType: imagePart.inlineData.mimeType,
                     textFallback: `(Gambar berhasil dibuat, tapi ada peringatan: ${candidate.finishReason})`
                 };
            } else {
                 console.error(`Gemini Image generation blocked for chat ${chatId}. Reason: ${candidate.finishReason}`);
                 const safetyRatings = candidate.safetyRatings ? ` (${candidate.safetyRatings.map(r => r.category + ':'+r.probability).join(', ')})` : '';
                 return { error: `Waduh ${userName}, gambar mu sus ;-;, generate yang lainnya` };
            }
        }

        const imagePart = candidate.content?.parts?.find(part => part.inlineData);

        if (imagePart?.inlineData?.data && imagePart?.inlineData?.mimeType) {
            console.log(`Image successfully generated for chat ${chatId}. MimeType: ${imagePart.inlineData.mimeType}`);
            const textPart = candidate.content?.parts?.find(part => part.text);
            const textFallback = textPart ? stripMarkdown(textPart.text) : null;

            return {
                base64Data: imagePart.inlineData.data,
                mimeType: imagePart.inlineData.mimeType,
                textFallback: textFallback
            };
        } else {
             const textPart = candidate.content?.parts?.find(part => part.text);
             if (textPart?.text) {
                 console.warn(`Gemini Image API (${modelToUse}) returned text instead of image for chat ${chatId}: "${textPart.text.substring(0,100)}..."`);
                 return { error: `Hmm ${userName}, Gambar mu sus coba ganti prompt` };
             } else {
                console.error(`Gemini Image response format unexpected or missing image data for chat ${chatId}.`, JSON.stringify(response.data, null, 2));
                return { error: `Waduh ${userName}, gambar mu sus ;-;` };
             }
        }

    } catch (error) {
        console.error(`Error calling Gemini Image API (${modelToUse}) for chat ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas bikin gambar pake AI. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI bikin gambarnya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan minta gambar nih kayaknya pake , coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            errorMsg = `Error dari AI Gambar - ${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
             if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah bikin gambar habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && apiError.message.includes("Request payload size")) {
                 errorMsg = `Waduh ${userName}, prompt gambarnya kepanjangan. Coba dipersingkat.`;
            } else if (apiError.message && apiError.message.includes("response modalities")) {
                 errorMsg = `Waduh ${userName}, model AI ini sepertinya nggak bisa generate gambar/teks sesuai permintaan. Mungkin modelnya salah? (${apiError.message})`;
            } else if (apiError.message && apiError.message.includes("SAFETY")) {
                errorMsg = `Maaf ${userName}, gambarmu sus ;-; Coba prompt yang lebih aman ya. (${apiError.message})`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server lagi ada masalah internal nih. Coba beberapa saat lagi.`;
        }
        return { error: errorMsg };
    }
}
// --- Akhir Fungsi generateImageWithGemini ---

// --- Handler Utama Vercel ---
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
        const repliedToMessage = message.reply_to_message;

        let nickname = username ? userNicknames[username.toLowerCase()] : null;
        const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
        const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

        let shouldProcessAI = false;
        let shouldGenerateImage = false;
        let promptForAI = "";
        let messageIdToReply = messageId;
        let enableGrounding = false;
        let triggerWordUsed = null;
        let imageBase64 = null;
        let imageMimeType = null;

        const lowerCaseText = messageText.toLowerCase();
        const BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

        const chatTriggers = ['/chat ', 'lele ', 'le ', 'tanya '];
        const groundingTriggers = ['/info ', 'inpo ', 'kabar ', '/po '];
        const imageTriggers = ['/img ', 'img ', 'buat ', 'gambar '];

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

        if (!shouldGenerateImage) {

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

            if (repliedToMessage?.photo?.length > 0 && messageText) {
                console.log(`Detected reply to photo by ${nameForAIContext} (${userId}). Checking text trigger...`);
                let visionTriggerFound = false;
                for (const trigger of chatTriggers) {
                    if (lowerCaseText.startsWith(trigger)) {
                        visionTriggerFound = true;
                        triggerWordUsed = `vision_${trigger.trim()}`;
                        promptForAI = messageText.substring(trigger.length).trim();
                        console.log(`Vision trigger '${trigger.trim()}' found in reply text.`);

                        try {
                            await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                            const photo = repliedToMessage.photo[repliedToMessage.photo.length - 1];
                            const fileId = photo.file_id;
                            console.log(`Getting file path for file_id: ${fileId}`);
                            const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                            const filePath = getFileResponse.data?.result?.file_path;
                            if (!filePath) { throw new Error('File path not found.'); }
                            console.log(`Got file path: ${filePath}`);
                            const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                            console.log(`Downloading image from: ${fileUrl}`);
                            const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
                            imageBase64 = Buffer.from(imageResponse.data).toString('base64');
                            if (filePath.toLowerCase().endsWith('.png')) { imageMimeType = 'image/png'; }
                            else if (filePath.toLowerCase().endsWith('.webp')) { imageMimeType = 'image/webp'; }
                            else { imageMimeType = 'image/jpeg'; }
                            console.log(`Image downloaded (${(imageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${imageMimeType}`);
                            shouldProcessAI = true;
                            enableGrounding = false;
                        } catch (error) {
                            console.error(`Error fetching/processing image for vision request (file_id: ${fileId}):`, error.message);
                            await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil/proses gambarnya nih. Coba lagi ya.`, messageId);
                            shouldProcessAI = false;
                            visionTriggerFound = false;
                        }
                        break;
                    }
                }
                if (!visionTriggerFound && messageText) {
                    console.log(`Ignoring reply to photo from ${nameForAIContext} (${userId}) because text does not start with a valid chat trigger.`);
                }
            }


            if (!shouldProcessAI) {
                enableGrounding = false;
                let groundingTriggerFound = false;
                for (const trigger of groundingTriggers) {
                    if (lowerCaseText.startsWith(trigger)) {
                        triggerWordUsed = trigger.trim();
                        promptForAI = messageText.substring(trigger.length).trim();
                        if (promptForAI) {
                            shouldProcessAI = true;
                            enableGrounding = true;
                            groundingTriggerFound = true;
                            console.log(`Processing TEXT message ${messageId} WITH grounding (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId})`);
                        } else {
                            await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari ${triggerWordUsed} apa? Contoh: ${triggerWordUsed} berita terkini tentang AI`, messageIdToReply);
                            shouldProcessAI = false;
                        }
                        break;
                    }
                }

                if (!groundingTriggerFound && !shouldProcessAI) {
                    if (chatType === 'private') {
                         if (messageText) {
                            shouldProcessAI = true;
                            promptForAI = messageText;
                            triggerWordUsed = 'private_chat';
                            enableGrounding = false;
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
                        let textTriggerFound = false;
                        if (messageText) {
                             for (const trigger of chatTriggers) {
                                if (lowerCaseText.startsWith(trigger)) {
                                    triggerWordUsed = trigger.trim();
                                    promptForAI = messageText.substring(trigger.length).trim();
                                    textTriggerFound = true;
                                    break;
                                }
                            }
                        }

                        if (!textTriggerFound && BOT_USER_ID && repliedToMessage?.from?.id === BOT_USER_ID && repliedToMessage.text) {
                              if (!repliedToMessage.photo) {
                                   triggerWordUsed = 'reply_to_bot_text';
                                   const botPreviousText = repliedToMessage.text;
                                   const userReplyText = messageText;

                                   let history = chatHistories[chatId] || [];
                                   const lastBotTurnIndex = history.map(h => h.role).lastIndexOf('model');

                                   if(lastBotTurnIndex !== -1 && history[lastBotTurnIndex].parts[0].text.includes(botPreviousText.substring(0, 50))) {
                                        promptForAI = userReplyText;
                                        console.log(`Continuing conversation based on reply to bot message ${repliedToMessage.message_id}`);
                                   } else {
                                        console.warn(`Could not find matching bot turn in history for reply ${repliedToMessage.message_id}. Creating manual context.`);
                                        promptForAI = `Ini adalah respons saya sebelumnya: "${botPreviousText}"\n\nSekarang tanggapi ini dari ${nameForAIContext}: "${userReplyText}"`;
                                        if(history.length > 2) {
                                            const systemPrompts = history.filter(h => h.role === 'system');
                                            chatHistories[chatId] = systemPrompts;
                                            console.warn(`Resetting history for chat ${chatId} due to potential context mismatch.`);
                                        }
                                   }
                                   textTriggerFound = true;
                              }
                         }

                        if (textTriggerFound && triggerWordUsed !== 'reply_to_bot_text' && repliedToMessage && repliedToMessage.text && repliedToMessage.from?.id !== BOT_USER_ID) {
                             const repliedText = repliedToMessage.text;
                             let originalSenderName = 'seseorang';
                              const repliedFrom = repliedToMessage.from;
                              if (repliedFrom) {
                                  const repliedUsername = repliedFrom.username ? repliedFrom.username.toLowerCase() : null;
                                  const repliedNickname = repliedUsername ? userNicknames[repliedUsername] : null;
                                 originalSenderName = repliedNickname || repliedFrom.first_name || (repliedFrom.username ? `@${repliedFrom.username}` : `User ${repliedFrom.id}`);
                              }
                             promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi pesan tersebut dengan memperhatikan pertanyaan/pernyataan saya (${nameForAIContext}) berikut: "${promptForAI}"`;
                             console.log(`Added context from replied text message ${repliedToMessage.message_id}`);
                             messageIdToReply = repliedToMessage.message_id;
                         }

                        if (textTriggerFound && promptForAI) {
                            shouldProcessAI = true;
                            enableGrounding = false;
                            console.log(`Trigger TEXT '${triggerWordUsed}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
                        } else if (textTriggerFound && !promptForAI && triggerWordUsed !== 'reply_to_bot_text') {
                            let helpText = `Iya ${nameForBotGreeting}? Mau ${triggerWordUsed} apa nih? Contoh: ${triggerWordUsed} jelaskan soal black hole`;
                            await sendMessage(chatId, helpText, messageIdToReply);
                            shouldProcessAI = false;
                        } else if (!textTriggerFound && messageText) {
                             if (!(repliedToMessage && repliedToMessage.photo)) {
                                console.log(`Ignoring non-trigger text message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
                             }
                             shouldProcessAI = false;
                         }
                    }
                     else if (!messageText && !repliedToMessage?.photo) {
                        console.log(`Ignoring message ${messageId} in chat ${chatId} because it has no text content and is not a reply to a photo.`);
                        shouldProcessAI = false;
                    }
                     else {
                         if (!(repliedToMessage && repliedToMessage.photo)) {
                            console.log(`Ignoring message from unsupported chat type: ${chatType} or unhandled condition.`);
                         }
                        shouldProcessAI = false;
                    }
                }
            }
        }


        if (shouldProcessAI) {
             const effectivePromptLength = (promptForAI || "").length + (imageBase64 ? imageBase64.length : 0);
             const MAX_EFFECTIVE_PROMPT = 4 * 1024 * 1024;

             console.log(`Effective TEXT/VISION prompt/image size: ${effectivePromptLength} bytes (Limit: ${MAX_EFFECTIVE_PROMPT})`);

             if (effectivePromptLength > MAX_EFFECTIVE_PROMPT) {
                 await sendMessage(chatId, `Waduh ${nameForBotGreeting}, permintaannya (${triggerWordUsed}) terlalu besar nih (prompt/gambar > ${(MAX_EFFECTIVE_PROMPT / 1024 / 1024).toFixed(1)} MB). Coba dipersingkat atau pakai gambar lebih kecil ya.`, messageIdToReply);
             } else if (!promptForAI && !imageBase64) {
                  console.warn(`shouldProcessAI is true but both prompt and image are missing for chat ${chatId}, message ${messageId}. Skipping.`);
             } else {
                 if (!imageBase64) {
                     try {
                         await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                     } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }
                 }

                 const aiResponseObject = await getGeminiResponse(
                     chatId,
                     promptForAI,
                     nameForAIContext,
                     enableGrounding,
                     imageBase64,
                     imageMimeType
                 );
                 await sendMessage(chatId, aiResponseObject.text, messageIdToReply);
             }
        }
        else if (shouldGenerateImage) {
            try {
                await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'upload_photo' });
            } catch (actionError) { console.warn("Could not send upload_photo action:", actionError.message); }

            const imageResult = await generateImageWithGemini(chatId, promptForAI, nameForAIContext);

            if (imageResult.base64Data && imageResult.mimeType) {
                const caption = `📷 Jika gambarnya aneh, harap dihapus yaa 🙏😭 \n\nbingung cari prompt? kesini aja https://poe.com/prompt-img-lele
                `;
                await sendPhotoFromBase64(chatId, imageResult.base64Data, imageResult.mimeType, caption, messageIdToReply);
            } else {
                await sendMessage(chatId, imageResult.error || `Waduh ${nameForBotGreeting}, gagal bikin gambarnya nih, coba lagi nanti ya.`, messageIdToReply);
            }
        }
        // --- Akhir Proses Image Generation ---

    } else if (update.message && update.message.chat) {
        const chatId = update.message.chat.id;
        console.log(`Ignoring non-text/photo/incomplete message update in chat ${chatId || 'unknown'}`);
    } else {
        console.log('Ignoring update that is not a message or lacks required fields.');
    }

    res.status(200).send('OK');
};
// --- Akhir Handler Utama Vercel ---