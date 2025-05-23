// api/webhook.js
const axios = require('axios');
const FormData = require('form-data');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_VISION_MODEL_NAME = process.env.GEMINI_VISION_MODEL_NAME;
const GEMINI_TEXT_MODEL_NAME = process.env.GEMINI_TEXT_MODEL_NAME;
const GEMINI_IMAGE_MODEL_NAME = process.env.GEMINI_IMAGE_MODEL_NAME;
const GEMINI_API_URL_BASE = `https://generativelanguage.googleapis.com/v1beta/models/`;

// --- Fungsi sendMessage -- 
async function sendMessage(chatId, text, replyToMessageId = null) {
    if (!BOT_TOKEN) {
        console.error("Bot token is not set.");
        return;
    }

    if (!text || text.trim() === '') {
        console.warn(`Attempted to send empty or whitespace-only message to ${chatId}. Sending fallback.`);
        text = "(Pesan kosong)"; 
    }

    const MAX_LENGTH = 4096;
    let remainingText = text;
    let isFirstChunk = true;
    let currentReplyToId = replyToMessageId;

    while (remainingText.length > 0) {
        let chunkToSend;
        let nextChunkStartIndex = 0;

        if (remainingText.length > MAX_LENGTH) {
            let splitPoint = remainingText.lastIndexOf('\n', MAX_LENGTH - 1); 

            if (splitPoint === -1 || splitPoint < MAX_LENGTH * 0.8) { 
                splitPoint = remainingText.lastIndexOf(' ', MAX_LENGTH - 1);
            }

            if (splitPoint === -1 || splitPoint < MAX_LENGTH * 0.5) { 
                splitPoint = MAX_LENGTH - 1;
            }

            chunkToSend = remainingText.substring(0, splitPoint + 1); 
            nextChunkStartIndex = splitPoint + 1;

        } else {
            chunkToSend = remainingText;
            nextChunkStartIndex = remainingText.length;
        }

        remainingText = remainingText.substring(nextChunkStartIndex).trimStart();

        if (!isFirstChunk && chunkToSend.trim()) {
            const prefix = "(lanjutan)\n";
            if (prefix.length + chunkToSend.length <= MAX_LENGTH) {
                chunkToSend = prefix + chunkToSend;
            } else {
                console.warn(`Chunk for ${chatId} cannot have '(lanjutan)' prefix due to length limit.`);
            }
        }

        const payload = {
            chat_id: chatId,
            text: chunkToSend,
            disable_web_page_preview: true
        };

        if (isFirstChunk && currentReplyToId) {
            payload.reply_to_message_id = currentReplyToId;
        }

        try {
            await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
            console.log(`Message chunk sent to ${chatId}` + (payload.reply_to_message_id ? ` in reply to ${payload.reply_to_message_id}` : '') + ` (length: ${chunkToSend.length})`);

            isFirstChunk = false; 

            if (remainingText.length > 0) {
                await new Promise(resolve => setTimeout(resolve, 300)); 
            }

        } catch (error) {
            console.error(`Error sending message chunk to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);

            if (error.response && error.response.status === 400 && error.response.data.description.includes("can't parse entities")) {
                console.warn(`!!! Potential formatting issue in chunk for ${chatId}. Raw text snippet: ${chunkToSend.substring(0, 100)}...`);
                const fallbackText = chunkToSend.replace(/[*_`\[\]()]/g, ''); 
                try {
                    console.log(`Attempting fallback send (chunk) without formatting chars to ${chatId}`);
                    const fallbackPayload = { ...payload, text: fallbackText.substring(0, MAX_LENGTH) }; 
                    await axios.post(`${TELEGRAM_API}/sendMessage`, fallbackPayload);
                    console.log(`Fallback chunk sent successfully to ${chatId}`);
                    isFirstChunk = false; 

                    if (remainingText.length > 0) {
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }

                } catch (fallbackError) {
                    console.error(`Fallback send (chunk) also failed for ${chatId}:`, fallbackError.response ? JSON.stringify(fallbackError.response.data, null, 2) : fallbackError.message);
                    console.error(`Stopping further message chunks for this message to ${chatId} due to send error.`);
                    break; 
                }
            } else {
                console.error(`Stopping further message chunks for this message to ${chatId} due to non-parsing send error.`);
                break; 
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
            temperature: 0.7,
            topP: 0.9,
            thinkingConfig: {
                thinkingBudget: 0
            }
        },
    };

    if (enableGrounding && !isVisionRequest) {
        requestBody.tools = [{ 'google_search': {} }];
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
            console.log("Original AI text received:", aiResponseText.substring(0, 100) + "...");
            aiResponseText = stripMarkdown(aiResponseText);
            console.log("AI text after stripping Markdown:", aiResponseText.substring(0, 100) + "...");

            history.push({ role: "model", parts: [{ text: aiResponseText }] });
            chatHistories[chatId] = history;

            let finalResponseText = aiResponseText;
            let parseMode = null;

            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", groundingAttributions.length);

                const sourceHostnames = groundingAttributions
                    .map(source => {
                        try {
                            const url = new URL(source.uri);
                            return url.hostname ? url.hostname.replace(/^www\./, '') : null;
                        } catch (e) {
                            console.warn(`Could not parse URI "${source.uri}" for hostname:`, e.message);
                            return null; 
                        }
                    })
                    .filter(hostname => hostname) 
                    .filter((hostname, index, self) => self.indexOf(hostname) === index);

                if (sourceHostnames.length > 0) {
                    finalResponseText += "\n\n__\nsource : " + sourceHostnames.join(", ");
                    console.log(`Formatted ${sourceHostnames.length} unique source hostnames.`);
                } else {
                    console.warn("Grounding was enabled, but no valid hostnames extracted from attributions.");
                }

            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions returned by API.");
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
            temperature: 0.3,
        },

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
                const safetyRatings = candidate.safetyRatings ? ` (${candidate.safetyRatings.map(r => r.category + ':' + r.probability).join(', ')})` : '';
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
                console.warn(`Gemini Image API (${modelToUse}) returned text instead of image for chat ${chatId}: "${textPart.text.substring(0, 100)}..."`);
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


// --- Handler untuk Inline Query (Default /chat, Explicit /info) ---
async function handleInlineQuery(inlineQuery, res) {
    const query = (inlineQuery.query || "").trim();
    const inlineQueryId = inlineQuery.id;
    const from = inlineQuery.from;
    const userId = from.id;
    const username = from.username;
    const firstName = from.first_name;

    let nickname = username ? userNicknames[username.toLowerCase()] : null;
    const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;

    console.log(`Received inline query from ${nameForAIContext} (${userId}): "${query}" (ID: ${inlineQueryId})`);

    let command = null;
    let promptForAI = '';
    let enableGrounding = false;
    let explicitTriggerFound = false;
    const lowerCaseQuery = query.toLowerCase();

    const groundingTriggers = [
        ['/info ', 'info', true],
        ['inpo ', 'info', true],
        ['kabar ', 'info', true],
        ['/po ', 'info', true],
    ];

    for (const [trigger, cmd, grounding] of groundingTriggers) {
        if (lowerCaseQuery.startsWith(trigger)) {
            command = cmd;
            promptForAI = query.substring(trigger.length).trim();
            enableGrounding = grounding;
            explicitTriggerFound = true;
            console.log(`Inline query matched GROUNDING: Command='${command}', Grounding=${enableGrounding}, Trigger='${trigger.trim()}'. Prompt: "${promptForAI}"`);
            break;
        }
    }

    if (!explicitTriggerFound) {
        const chatTriggers = [
            ['/chat ', 'chat', false],
            ['lele ', 'chat', false],
            ['le ', 'chat', false],
            ['tanya ', 'chat', false]
        ];
        for (const [trigger, cmd, grounding] of chatTriggers) {
            if (lowerCaseQuery.startsWith(trigger)) {
                command = cmd;
                promptForAI = query.substring(trigger.length).trim();
                enableGrounding = grounding;
                explicitTriggerFound = true;
                console.log(`Inline query matched EXPLICIT CHAT: Command='${command}', Grounding=${enableGrounding}, Trigger='${trigger.trim()}'. Prompt: "${promptForAI}"`);
                break;
            }
        }
    }

    if (!explicitTriggerFound && query) {
        command = 'chat';
        promptForAI = query;
        enableGrounding = false;
        console.log(`Inline query using DEFAULT CHAT behavior. Command='${command}', Grounding=${enableGrounding}. Prompt: "${promptForAI}"`);
    }

    if (!command) {
        console.log(`Inline query is empty or invalid. Ignoring.`);
        const suggestion = query ? null : "Sabar, si Ai lagi mikir uyy 😭";
        return answerInlineQuery(inlineQueryId, [], res, suggestion);
    }

    if (explicitTriggerFound && !promptForAI) {
        const usedTrigger = query.trim().split(' ')[0];
        console.log(`Inline query has explicit trigger "${usedTrigger}" but no prompt text.`);
        return answerInlineQuery(inlineQueryId, [], res, `Butuh teks setelah ${usedTrigger}...`);
    }

    let results = [];
    let errorMessageForResult = null;

    try {
        console.log(`Getting ${enableGrounding ? 'grounded' : 'standard'} AI response for inline query ID ${inlineQueryId}...`);
        const contextId = `inline_${userId}_${Date.now()}`;
        const aiResponseObject = await getGeminiResponse(
            contextId,
            promptForAI,
            nameForAIContext,
            enableGrounding,
            null, null
        );
        if (chatHistories[contextId]) {
            delete chatHistories[contextId];
            console.log(`Cleaned up temporary inline context: ${contextId}`);
        }

        if (aiResponseObject && aiResponseObject.text && !aiResponseObject.text.toLowerCase().includes("gagal") && !aiResponseObject.text.toLowerCase().includes("maaf")) {
            const responseText = aiResponseObject.text;
            const title = `${enableGrounding ? 'Info' : 'Chat'}: ${promptForAI.substring(0, 40)}${promptForAI.length > 40 ? '...' : ''}`;
            const description = responseText.substring(0, 100) + (responseText.length > 100 ? '...' : '');

            results.push({
                type: 'article',
                id: `${command}_${Date.now()}_${Math.random().toString(36).substring(7)}`,
                title: title,
                description: description,
                input_message_content: {
                    message_text: responseText,
                    disable_web_page_preview: true
                },
            });
            console.log(`Prepared InlineQueryResultArticle for query ID ${inlineQueryId}`);
        } else {
            errorMessageForResult = aiResponseObject.text || `Gagal mendapatkan respons ${command}.`;
            console.warn(`AI response failed or contained error for inline query ID ${inlineQueryId}: ${errorMessageForResult}`);
        }

    } catch (error) {
        console.error(`Error processing inline query ID ${inlineQueryId} ("${query}"):`, error);
        errorMessageForResult = "Waduh, ada masalah internal pas proses permintaanmu.";
    }

    if (errorMessageForResult && results.length === 0) {
        results.push({
            type: 'article',
            id: `error_${Date.now()}`,
            title: "Error",
            description: errorMessageForResult.substring(0, 100),
            input_message_content: { message_text: errorMessageForResult }
        });
        console.log(`Prepared error message as InlineQueryResultArticle for query ID ${inlineQueryId}`);
    }

    return answerInlineQuery(inlineQueryId, results, res);
}

async function answerInlineQuery(inlineQueryId, results, res, switchPmText = null, switchPmParameter = 'inline_help') {
    const payload = {
        inline_query_id: inlineQueryId,
        results: results,
        cache_time: 5
    };

    if (switchPmText) {
        payload.switch_pm_text = switchPmText;
        payload.switch_pm_parameter = switchPmParameter;
    }

    try {
        await axios.post(`${TELEGRAM_API}/answerInlineQuery`, payload);
        console.log(`Answered inline query ${inlineQueryId} with ${results.length} results.` + (switchPmText ? ` Switch PM: "${switchPmText}"` : ''));
        if (!res.headersSent) {
            res.status(200).send('OK');
        }
    } catch (error) {
        console.error(`Error answering inline query ${inlineQueryId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        if (!res.headersSent) {
            res.status(500).send('Error answering query');
        }
    }
}

// --- Akhir Handler Inline Query ---

// --- Inline Gambar ---
async function generateImageForInlineQuery(prompt) {
    try {
        const imageResult = await generateImageWithGemini(null, prompt, 'Inline User');

        if (imageResult.error) {
            console.warn(`Image generation failed for inline query "${prompt}": ${imageResult.error}`);
            return { error: imageResult.error };
        }

        if (imageResult.base64Data && imageResult.mimeType) {
            console.log(`Image generated successfully for inline query "${prompt}"`);
            return { base64Data: imageResult.base64Data, mimeType: imageResult.mimeType };
        } else {
            console.error(`Unexpected result from generateImageWithGemini for inline query "${prompt}"`);
            return { error: 'Gagal membuat gambar.' };
        }
    } catch (error) {
        console.error(`Error in generateImageForInlineQuery:`, error);
        return { error: 'Terjadi kesalahan saat memproses permintaan.' };
    }
}
// --- Akhir Gambar ---

// --- Pengembalian ---

async function answerInlineQuery(inlineQueryId, results, res, switchPmText = null, switchPmParameter = 'inline_error') {
    const payload = {
        inline_query_id: inlineQueryId,
        results: results,
        cache_time: 10
    };

    if (switchPmText) {
        payload.switch_pm_text = switchPmText;
        payload.switch_pm_parameter = switchPmParameter;
    }

    try {

        await axios.post(`${TELEGRAM_API}/answerInlineQuery`, payload);
        console.log(`Answered inline query ${inlineQueryId} with ${results.length} results.`);
        if (!res.headersSent) {
            res.status(200).send('OK');
        }
    } catch (error) {
        console.error(`Error answering inline query ${inlineQueryId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        if (!res.headersSent) {
            res.status(500).send('Error answering query');
        }
    }
}

// --- Akhir Pengembalian ---

// --- Handler Utama Vercel ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed' }); }
    if (!req.body || typeof req.body !== 'object') {
        console.log('Received invalid or empty request body.');
        return res.status(200).send('OK - Invalid body');
    }

    console.log('Received update:', JSON.stringify(req.body, null, 2));
    const update = req.body;

    if (update.inline_query) {
        await handleInlineQuery(update.inline_query, res);
        return;
    }

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

        const chatTriggers = ['/chat ', 'lele ', 'le '];
        const groundingTriggers = ['/info ', 'inpo ', '/po '];
        const imageTriggers = ['/img ', 'img ', 'gambar '];

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
                            console.log(`Image downloaded (${(imageBase64.length * 3 / 4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${imageMimeType}`);
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
                                if (query) {
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

                                if (lastBotTurnIndex !== -1 && history[lastBotTurnIndex].parts[0].text.includes(botPreviousText.substring(0, 50))) {
                                    promptForAI = userReplyText;
                                    console.log(`Continuing conversation based on reply to bot message ${repliedToMessage.message_id}`);
                                } else {
                                    console.warn(`Could not find matching bot turn in history for reply ${repliedToMessage.message_id}. Creating manual context.`);
                                    promptForAI = `Ini adalah respons saya sebelumnya: "${botPreviousText}"\n\nSekarang tanggapi ini dari ${nameForAIContext}: "${userReplyText}"`;
                                    if (history.length > 2) {
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