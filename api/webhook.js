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

let chatHistories = {};
const MAX_HISTORY_LENGTH = 50;

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
        }
        else if (categoryHeaderMatch && !startsWithWhitespaceRegex.test(categoryHeaderMatch[1]) && nextLine && listItemRegex.test(nextLine)) {
             processedLine = processedLine.trim();
             addCheckMark = true;
        }
        else {
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
        const systemPromptIndices = history.reduce((indices, turn, index) => {
            if (turn.role === 'system') indices.push(index);
            return indices;
        }, []);
        const systemPromptsCount = systemPromptIndices.length;
        const conversationTurns = (history.length - systemPromptsCount);

        const turnsToKeep = isVisionRequest ? 3 : 5;

        if (conversationTurns > turnsToKeep * 2) {
            const itemsToRemove = Math.max(0, conversationTurns - (turnsToKeep * 2));
             if (itemsToRemove > 0) {
                 const startIndexToRemove = systemPromptsCount > 0 ? systemPromptIndices[systemPromptsCount - 1] + 1 : 0;
                 history.splice(startIndexToRemove, itemsToRemove);
                 console.log(`Trimmed ${itemsToRemove} items (turns) from history for chat ${chatId}`);
             }
        }
     }

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
            errorMsg = `Error dari AI (${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}.`;
             if (apiError.message && apiError.message.includes("API key not valid")) {
                 errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
            } else if (apiError.message && apiError.message.includes("quota")) {
                 errorMsg = `Aduh ${userName}, jatah (${modelToUse}) habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
            } else if (apiError.message && apiError.message.includes("inline data")) {
                 errorMsg = `Waduh ${userName}, sepertinya ada masalah pas ngirim data gambar/file ke AI. Ukuran atau formatnya mungkin? (${apiError.message})`;
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI lagi ada masalah internal nih (${error.response.status}). Coba beberapa saat lagi.`;
        }
        return { text: errorMsg, parseMode: null };
    }
}

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
            // HAPUS BARIS INI: responseMimeType: "image/png",
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
            if (imagePart?.inlineData?.data && imagePart?.inlineData?.mimeType) {
                 console.log(`Image found despite finish reason ${candidate.finishReason} for chat ${chatId}. Proceeding.`);
                 return {
                     base64Data: imagePart.inlineData.data,
                     mimeType: imagePart.inlineData.mimeType,
                     textFallback: `(Gambar berhasil dibuat, tapi ada peringatan: ${candidate.finishReason})`
                 };
            } else {
                 console.error(`Gemini Image generation blocked for chat ${chatId}. Reason: ${candidate.finishReason}`);
                 const safetyRatings = candidate.safetyRatings ? ` (${candidate.safetyRatings.map(r => r.category + ':'+r.probability).join(', ')})` : '';
                 let blockMessage = `Waduh ${userName}, pembuatan gambar diblokir (${candidate.finishReason})${safetyRatings}. Coba prompt yang berbeda ya.`;
                 if (candidate.finishReason === 'SAFETY') {
                    blockMessage = `Maaf ${userName}, gambarmu dianggap tidak aman (SAFETY). Coba prompt yang lebih umum ya.${safetyRatings}`;
                 } else if (candidate.finishReason === 'RECITATION') {
                    blockMessage = `Maaf ${userName}, gambarmu terlalu mirip dengan materi berhak cipta (RECITATION). Coba prompt yang lebih unik.`;
                 }
                 return { error: blockMessage };
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
                 return { error: `Hmm ${userName}, AI bilang: "${stripMarkdown(textPart.text)}"` };
             } else {
                console.error(`Gemini Image response format unexpected or missing image data for chat ${chatId}.`, JSON.stringify(response.data, null, 2));
                return { error: `Waduh ${userName}, respons AI-nya aneh nih, nggak ada data gambarnya.` };
             }
        }

    } catch (error) {
        console.error(`Error calling Gemini Image API (${modelToUse}) for chat ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas bikin gambar pake AI. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || (error.message && error.message.toLowerCase().includes('timeout'))) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI bikin gambarnya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan minta gambar nih kayaknya, coba santai dulu bentar`; }
        else if (error.response?.data?.error) {
            const apiError = error.response.data.error;
            // Perbarui pesan error ini agar lebih spesifik jika error terkait responseMimeType muncul lagi
            if (apiError.message && apiError.message.includes('response_mime_type')) {
                 errorMsg = `Waduh ${userName}, ada masalah konfigurasi internal saat minta gambar. Coba kontak admin. (Detail: ${apiError.message})`;
            } else {
                 errorMsg = `Error dari AI Gambar (${apiError.code || error.response.status}): ${apiError.message || 'Gagal memproses'}. Coba cek lagi ${userName}.`;
                 if (apiError.message && apiError.message.includes("API key not valid")) {
                     errorMsg = `Waduh ${userName}, API Key Gemini sepertinya salah atau belum diatur nih. Cek konfigurasi ya.`;
                 } else if (apiError.message && apiError.message.includes("quota")) {
                     errorMsg = `Aduh ${userName}, jatah bikin gambar (${modelToUse}) habis nih kayaknya. Coba lagi besok atau hubungi admin.`;
                 } else if (apiError.message && apiError.message.includes("Request payload size")) {
                     errorMsg = `Waduh ${userName}, prompt gambarnya kepanjangan. Coba dipersingkat.`;
                 } else if (apiError.message && apiError.message.includes("response modalities") || apiError.message.includes("responseMimeType")) {
                     errorMsg = `Waduh ${userName}, model AI (${modelToUse}) ini sepertinya nggak bisa generate gambar atau formatnya salah. Mungkin modelnya perlu diganti? (${apiError.message})`;
                 } else if (apiError.message && apiError.message.includes("SAFETY")) {
                    errorMsg = `Maaf ${userName}, prompt gambarmu diblokir karena alasan keamanan (SAFETY). Coba prompt yang lebih aman ya. (${apiError.message})`;
                 }
            }
        } else if (error.response && error.response.status >= 500) {
             errorMsg = `Aduh ${userName}, kayaknya server AI gambar lagi ada masalah internal nih (${error.response.status}). Coba beberapa saat lagi.`;
        }
        return { error: errorMsg };
    }
}
// --- Akhir Fungsi generateImageWithGemini ---


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

    const chatTriggers = [
        ['/chat ', 'chat', false],
        ['lele ', 'chat', false],
        ['le ', 'chat', false],
        ['tanya ', 'chat', false]
    ];

    const imageTriggersInline = [
        ['/img ', 'img', false],
        ['img ', 'img', false],
        ['gambar ', 'img', false],
        ['buat ', 'img', false],
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

     if (!explicitTriggerFound) {
        for (const [trigger, cmd, grounding] of imageTriggersInline) {
            if (lowerCaseQuery.startsWith(trigger)) {
                command = cmd;
                promptForAI = query.substring(trigger.length).trim();
                enableGrounding = grounding;
                explicitTriggerFound = true;
                console.log(`Inline query matched IMAGE: Command='${command}', Trigger='${trigger.trim()}'. Prompt: "${promptForAI}"`);
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

    if (explicitTriggerFound && !promptForAI) {
        const usedTrigger = query.trim().split(' ')[0];
        console.log(`Inline query has explicit trigger "${usedTrigger}" but no prompt text.`);
        return answerInlineQuery(inlineQueryId, [], res, `Butuh teks setelah ${usedTrigger}...`, 'inline_prompt_needed');
    }

    if (!command) {
        console.log(`Inline query is empty or no command determined. Sending default suggestion.`);
        const suggestion = "Ketik sesuatu untuk ngobrol atau pakai /info, /img...";
        return answerInlineQuery(inlineQueryId, [], res, suggestion, 'inline_help');
    }


    let results = [];
    let errorMessageForResult = null;
    let switchPmText = null;
    let switchPmParam = 'inline_error';

    try {
        if (command === 'chat' || command === 'info') {
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
                 switchPmText = errorMessageForResult.substring(0, 60) + (errorMessageForResult.length > 60 ? "..." : "");
                 switchPmParam = 'inline_ai_error';
            }
        }
        else if (command === 'img') {
            console.log(`Generating image for inline query ID ${inlineQueryId}...`);

            results.push({
                type: 'article',
                id: `img_request_${Date.now()}`,
                title: `Buat gambar: ${promptForAI.substring(0,40)}...`,
                description: "Pilih ini untuk meminta gambar (hasil akan dikirim via chat pribadi).",
                input_message_content: {
                    message_text: `Oke, saya coba buatkan gambar "${promptForAI}". Tunggu sebentar ya... (Hasil mungkin akan dikirim lewat chat pribadi jika ini inline)`
                },
            });
             console.log(`Prepared InlineQueryResultArticle placeholder for image request ID ${inlineQueryId}`);
        }

    } catch (error) {
        console.error(`Error processing inline query ID ${inlineQueryId} ("${query}"):`, error);
        errorMessageForResult = "Waduh, ada masalah internal pas proses permintaanmu.";
        switchPmText = errorMessageForResult;
        switchPmParam = 'inline_internal_error';
    }

    if (errorMessageForResult && results.length === 0 && !switchPmText) {
         switchPmText = errorMessageForResult.substring(0, 60) + (errorMessageForResult.length > 60 ? "..." : "");
         switchPmParam = 'inline_fallback_error';
         console.log(`Using switch_pm for error message for query ID ${inlineQueryId}`);
    }

    return answerInlineQuery(inlineQueryId, results, res, switchPmText, switchPmParam);
}

async function answerInlineQuery(inlineQueryId, results, res, switchPmText = null, switchPmParameter = 'inline_info') {
    const payload = {
        inline_query_id: inlineQueryId,
        results: results,
        cache_time: 5
    };

    if (switchPmText) {
        payload.switch_pm_text = switchPmText.substring(0, 64);
        payload.switch_pm_parameter = switchPmParameter.substring(0, 64);
    }

    try {
        await axios.post(`${TELEGRAM_API}/answerInlineQuery`, payload);
        console.log(`Answered inline query ${inlineQueryId} with ${results.length} results.` + (switchPmText ? ` Switch PM: "${payload.switch_pm_text}" (${payload.switch_pm_parameter})` : ''));
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


module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        console.log('Received non-POST request.');
        return res.status(405).json({ error: 'Method Not Allowed' });
    }
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

    if (update.chosen_inline_result) {
        const { result_id, from, query } = update.chosen_inline_result;
        const userId = from.id;
        const name = from.first_name || from.username || userId;
        console.log(`User ${name} (${userId}) chose inline result ID: ${result_id} for query: "${query}"`);
        return res.status(200).send('OK - ChosenInlineResult logged');
    }


    if (update.message && update.message.chat && update.message.from) {
        const chatId = update.message.chat.id;
        const message = update.message;
        const messageText = (message.text || message.caption || "").trim();
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


             const photoInRepliedMessage = repliedToMessage?.photo?.length > 0 ? repliedToMessage.photo[repliedToMessage.photo.length - 1] : null;
            const photoInCurrentMessage = message?.photo?.length > 0 ? message.photo[message.photo.length - 1] : null;
            const photoToProcess = photoInCurrentMessage || photoInRepliedMessage;

            if (photoToProcess && messageText) {
                console.log(`Detected photo (ID: ${photoToProcess.file_id}) with text by ${nameForAIContext} (${userId}). Checking text trigger...`);
                let visionTriggerFound = false;

                 for (const trigger of chatTriggers) {
                    if (lowerCaseText.startsWith(trigger)) {
                         visionTriggerFound = true;
                         triggerWordUsed = `vision_${trigger.trim()}`;
                         promptForAI = messageText.substring(trigger.length).trim();
                         console.log(`Vision trigger '${trigger.trim()}' found with photo.`);
                         break;
                     }
                 }

                 if (!visionTriggerFound && messageText && photoInCurrentMessage) {
                     visionTriggerFound = true;
                     triggerWordUsed = 'vision_caption';
                     promptForAI = messageText;
                     console.log(`Using caption/text as prompt for photo.`);
                 }
                  else if (!visionTriggerFound && messageText && photoInRepliedMessage) {
                    for (const trigger of chatTriggers) {
                         if (lowerCaseText.startsWith(trigger)) {
                             visionTriggerFound = true;
                             triggerWordUsed = `vision_reply_${trigger.trim()}`;
                             promptForAI = messageText.substring(trigger.length).trim();
                             console.log(`Vision trigger '${trigger.trim()}' found in reply to photo.`);
                             messageIdToReply = repliedToMessage.message_id;
                             break;
                         }
                     }
                  }


                if (visionTriggerFound) {
                    try {
                        await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });

                        const fileId = photoToProcess.file_id;
                        console.log(`Getting file path for file_id: ${fileId}`);
                        const getFileResponse = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
                        const filePath = getFileResponse.data?.result?.file_path;

                        if (!filePath) { throw new Error('File path not found in Telegram response.'); }
                        console.log(`Got file path: ${filePath}`);

                        const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
                        console.log(`Downloading image from: ${fileUrl}`);
                        const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });

                        imageBase64 = Buffer.from(imageResponse.data).toString('base64');

                        if (filePath.toLowerCase().endsWith('.png')) { imageMimeType = 'image/png'; }
                        else if (filePath.toLowerCase().endsWith('.webp')) { imageMimeType = 'image/webp'; }
                        else if (filePath.toLowerCase().endsWith('.gif')) { imageMimeType = 'image/gif'; }
                        else { imageMimeType = 'image/jpeg'; }

                        console.log(`Image downloaded (${(imageBase64.length * 3/4 / 1024).toFixed(2)} KB) and encoded. MimeType: ${imageMimeType}`);
                        shouldProcessAI = true;
                        enableGrounding = false;

                    } catch (error) {
                        console.error(`Error fetching/processing image for vision request (file_id: ${fileId}):`, error.message);
                        await sendMessage(chatId, `Waduh ${nameForBotGreeting}, gagal ngambil/proses gambarnya nih. Coba lagi ya (${error.code || error.message}).`, messageId);
                        shouldProcessAI = false;
                        visionTriggerFound = false;
                    }
                } else {
                    console.log(`Ignoring photo message from ${nameForAIContext} (${userId}) because text does not start with a valid chat trigger or isn't a caption.`);
                }
            }

            // Start Block for Grounding Trigger Check (Modified Part)
            if (!shouldProcessAI) {
                enableGrounding = false;
                let groundingTriggerFound = false;
                for (const trigger of groundingTriggers) {
                    if (lowerCaseText.startsWith(trigger)) {
                        triggerWordUsed = trigger.trim();

                        let potentialPrompt = messageText.substring(trigger.length).trim();

                        if (!potentialPrompt) {
                            await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari ${triggerWordUsed} apa? Contoh: ${triggerWordUsed} berita terkini tentang AI`, messageIdToReply);
                            shouldProcessAI = false;
                            groundingTriggerFound = true;
                            break;
                        }

                        if (repliedToMessage && repliedToMessage.text && repliedToMessage.from?.id !== BOT_USER_ID) {
                            const repliedText = repliedToMessage.text;
                            let originalSenderName = 'seseorang';
                            const repliedFrom = repliedToMessage.from;
                            if (repliedFrom) {
                                const repliedUsername = repliedFrom.username ? repliedFrom.username.toLowerCase() : null;
                                const repliedNickname = repliedUsername ? userNicknames[repliedUsername] : null;
                                originalSenderName = repliedNickname || repliedFrom.first_name || (repliedFrom.username ? `@${repliedFrom.username}` : `User ${repliedFrom.id}`);
                            }
                            promptForAI = `Berikut adalah pesan dari ${originalSenderName}: "${repliedText}"\n\nTanggapi permintaan informasi saya (${nameForAIContext}) terkait pesan itu: "${potentialPrompt}"`;
                            console.log(`Added context from replied text message ${repliedToMessage.message_id} for GROUNDING request.`);
                            messageIdToReply = repliedToMessage.message_id;
                            shouldProcessAI = true;
                            enableGrounding = true;
                            groundingTriggerFound = true;
                        } else {
                            promptForAI = potentialPrompt;
                            shouldProcessAI = true;
                            enableGrounding = true;
                            groundingTriggerFound = true;
                            console.log(`Processing TEXT message ${messageId} WITH grounding (Trigger: '${triggerWordUsed}') from ${nameForAIContext} (${userId}) - NO reply context`);
                        }

                        break;
                    }
                }

                 // Continue with chat triggers / private / group logic ONLY if grounding trigger wasn't found/processed
                if (!groundingTriggerFound && !shouldProcessAI) {
                     // --- Handle Private Chat ---
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
                                 } else {
                                     console.log(`Implicit grounding keyword used in private chat but no query. Proceeding without grounding.`);
                                 }
                            } else {
                                 console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
                            }
                        } else {
                             console.log(`Ignoring empty private message ${messageId} from ${nameForAIContext} (${userId})`);
                             shouldProcessAI = false;
                        }
                    }
                    // --- Handle Group/Supergroup Chat ---
                    else if (chatType === 'group' || chatType === 'supergroup') {
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

                        if (!textTriggerFound && BOT_USER_ID && repliedToMessage?.from?.id === BOT_USER_ID && repliedToMessage.text && !repliedToMessage.photo) {
                              triggerWordUsed = 'reply_to_bot_text';
                              const botPreviousText = repliedToMessage.text;
                              const userReplyText = messageText;

                              let history = chatHistories[chatId] || [];
                              const lastBotTurnIndex = history.map(h => h.role).lastIndexOf('model');

                              if(lastBotTurnIndex !== -1 && history[lastBotTurnIndex].parts[0].text.includes(botPreviousText.substring(0, 50))) {
                                   promptForAI = userReplyText;
                                   console.log(`Continuing conversation based on reply to bot message ${repliedToMessage.message_id}`);
                              } else {
                                   console.warn(`Could not reliably find matching bot turn in history for reply ${repliedToMessage.message_id}. Creating manual context.`);
                                   promptForAI = `Ini adalah respons saya sebelumnya: "${botPreviousText}"\n\nSekarang tanggapi ini dari ${nameForAIContext}: "${userReplyText}"`;
                              }
                              textTriggerFound = true;
                              shouldProcessAI = true;
                              enableGrounding = false;
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
                             console.log(`Added context from replied text message ${repliedToMessage.message_id} for CHAT request.`);
                             messageIdToReply = repliedToMessage.message_id;
                         }

                        if (textTriggerFound && promptForAI && !shouldProcessAI) {
                            shouldProcessAI = true;
                            enableGrounding = false;
                            console.log(`Trigger TEXT '${triggerWordUsed}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
                        } else if (textTriggerFound && !promptForAI && triggerWordUsed !== 'reply_to_bot_text') {
                            let helpText = `Iya ${nameForBotGreeting}? Mau ${triggerWordUsed} apa nih? Contoh: ${triggerWordUsed} jelaskan soal black hole`;
                            await sendMessage(chatId, helpText, messageIdToReply);
                            shouldProcessAI = false;
                        } else if (!textTriggerFound && messageText) {
                             if (!photoToProcess) {
                                console.log(`Ignoring non-trigger text message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
                             }
                             shouldProcessAI = false;
                         }
                    }
                     else if (!messageText && !photoToProcess) {
                        console.log(`Ignoring message ${messageId} in chat ${chatId} because it has no text/photo content.`);
                        shouldProcessAI = false;
                    }
                     else {
                         if (!photoToProcess) {
                            console.log(`Ignoring message from unsupported chat type: ${chatType} or unhandled condition.`);
                         }
                        shouldProcessAI = false;
                    }
                } // End of if (!groundingTriggerFound && !shouldProcessAI)
            } // End of if (!shouldProcessAI) checking after vision attempt
            // End Block for Grounding Trigger Check

        }


        if (shouldProcessAI) {
             const effectivePromptLength = (promptForAI || "").length + (imageBase64 ? imageBase64.length : 0);
             const MAX_EFFECTIVE_PROMPT_BYTES = 4 * 1024 * 1024;

             console.log(`Effective TEXT/VISION prompt/image size: ${Math.round(effectivePromptLength / 1024)} KB (Limit: ${MAX_EFFECTIVE_PROMPT_BYTES / 1024 / 1024} MB)`);

             if (effectivePromptLength > MAX_EFFECTIVE_PROMPT_BYTES) {
                 await sendMessage(chatId, `Waduh ${nameForBotGreeting}, permintaannya (${triggerWordUsed}) terlalu besar nih (prompt/gambar > ${(MAX_EFFECTIVE_PROMPT_BYTES / 1024 / 1024).toFixed(1)} MB). Coba dipersingkat atau pakai gambar lebih kecil ya.`, messageIdToReply);
             } else if (!promptForAI && !imageBase64) {
                  console.warn(`shouldProcessAI is true but both prompt and image are missing for chat ${chatId}, message ${messageId}. Skipping AI call.`);
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
                const caption = `Ini gambarnya, ${nameForBotGreeting}! Diminta oleh ${nameForAIContext}.\nPrompt: ${promptForAI.substring(0, 150)}${promptForAI.length > 150 ? '...' : ''}${imageResult.textFallback ? `\n\n${imageResult.textFallback}` : ''}`;
                await sendPhotoFromBase64(chatId, imageResult.base64Data, imageResult.mimeType, caption, messageIdToReply);
            } else {
                await sendMessage(chatId, imageResult.error || `Waduh ${nameForBotGreeting}, gagal bikin gambarnya nih, coba lagi nanti ya.`, messageIdToReply);
            }
        }

    } else if (update.message && update.message.chat) {
        const chatId = update.message.chat.id;
        console.log(`Ignoring non-text/photo/caption/incomplete message update in chat ${chatId || 'unknown'}`);
    } else if (!update.inline_query && !update.chosen_inline_result) {
        console.log('Ignoring update that is not a message, inline query, or chosen inline result.');
    }

    if (!res.headersSent) {
        res.status(200).send('OK');
    }
};