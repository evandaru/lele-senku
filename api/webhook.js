// api/webhook.js
const axios = require('axios');
const OpenAI = require('openai'); // <-- Tetap diperlukan
const FormData = require('form-data'); // <-- Tetap diperlukan
const { Readable } = require('stream'); // <-- Import stream (meski mungkin tidak langsung digunakan, aman untuk disimpan)

// Ambil token & key dari environment variable
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENAI_API_KEY = "sk-proj-oRlSpQpYVVUjaMSc530wx5KzFLmrNCtyOurTbO234VqMcfBW0OS9Z4wiJR8kFFlo6zgmb-1qRIT3BlbkFJ6KGF3z4t4AG2xQ-cFz9nM7zCHaPPY5tI8MvgzOO67v4JGRyzTHL_vt5P7AckiZ8WN4O3bsi_4A"; // <-- Ambil OpenAI Key

// Pastikan ini adalah systemInstruction yang sudah diubah (tanpa instruksi Markdown)
const systemInstructionText = require('./systemInstruction.js');
const userNicknames = require('./userNicknames.js');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GEMINI_MODEL_NAME = "gemini-2.0-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;

// --- OpenAI TTS Configuration (DIPERBARUI sesuai dokumentasi) ---
let openai;
if (OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
    console.warn("OpenAI API Key is not set. /voice command will not work.");
}
// Instruksi spesifik untuk TTS (dari contoh Anda)
const TTS_INSTRUCTIONS = "Voice Affect: Agitated, High-pitched, Strained, High-energy (but in a negative/panicked way).\n\nTone: Panicked, Fearful, Shouting/Screaming, Urgent, Almost out of breath. Think like, full-on \"OMG, we're all gonna die!\" vibes.\n\nPacing: EXTREMELY FAST. We're talking Usain Bolt levels of speed-talking. Words are tumbling out, barely any pauses, sentences are short and choppy 'cause this person is freaking out.\n\nEmotions: Intense Fear, Panic, Shock, Urgency, Desperation (depending on the sitch). Basically, they're experiencing all the bad feels, all at once.\n\nPronunciation: Often clipped or slightly slurred due to speed and panic. Imagine someone trying to explain a horror movie while actually living it. Exclamations like \"WHAT WAS THAT?!\" \"RUN!\" \"OH MY GOD!\" are gonna be super loud and clear (even if their voice cracks a bit). Regular words? Not so much precision.\n\nPauses: Almost non-existent, except for sharp gasps for breath or sudden halts due to shock/jumpscares. It's like a verbal ro"; // Pastikan ini lengkap
const TTS_MODEL = "gpt-4o-mini-tts"; // <-- Gunakan model yang benar sesuai docs
const TTS_VOICE = "sage";            // <-- Gunakan voice dari contoh Anda (atau pilih dari: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer)
// --- End OpenAI TTS Configuration ---

// --- Fungsi sendMessage (TETAP SAMA) ---
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

// --- Fungsi sendAudio (TETAP SAMA, tapi perhatikan caption) ---
async function sendAudio(chatId, audioBuffer, replyToMessageId = null, caption = null) {
    if (!BOT_TOKEN) {
        console.error("Bot token is not set.");
        return;
    }
    if (!audioBuffer || audioBuffer.length === 0) {
        console.error("Attempted to send empty audio buffer.");
        await sendMessage(chatId, "Maaf, gagal membuat audio.", replyToMessageId);
        return;
    }

    try {
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        formData.append('audio', audioBuffer, { filename: 'voice.mp3', contentType: 'audio/mpeg' }); // Asumsi output MP3

        if (replyToMessageId) {
            formData.append('reply_to_message_id', String(replyToMessageId));
        }
        if (caption) {
             // Tambahkan pemberitahuan AI sesuai kebijakan OpenAI
             const finalCaption = `${caption}\n\n(Suara dihasilkan oleh AI)`;
             formData.append('caption', finalCaption);
        } else {
             formData.append('caption', '(Suara dihasilkan oleh AI)'); // Minimal pemberitahuan
        }


        console.log(`Sending audio to chat ${chatId}` + (replyToMessageId ? ` in reply to ${replyToMessageId}` : ''));

        await axios.post(`${TELEGRAM_API}/sendAudio`, formData, {
            headers: formData.getHeaders(),
            timeout: 60000
        });

        console.log(`Audio sent successfully to ${chatId}.`);

    } catch (error) {
        console.error(`Error sending audio to ${chatId}:`, error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        let errorText = "Aduh, maaf, gagal mengirim file audionya.";
        if (error.response && error.response.data && error.response.data.description) {
            errorText += `\nDetail: ${error.response.data.description}`;
        }
        await sendMessage(chatId, errorText, replyToMessageId);
    }
}
// --- Akhir Fungsi sendAudio ---

// --- Riwayat & Nama Panggilan (TETAP SAMA) ---
let chatHistories = {};
const MAX_HISTORY_LENGTH = 50;
// --- Akhir Simulasi Penyimpanan ---

// --- Fungsi Panggil Gemini (TETAP SAMA) ---
async function getGeminiResponse(chatId, newUserPrompt, userName = 'mas', enableGrounding = false) {
    // ... (Kode fungsi getGeminiResponse tidak berubah) ...
    if (!GEMINI_API_KEY) {
        console.error("Gemini API key is not set.");
        return { text: "Maaf, konfigurasi AI (Gemini) belum diatur.", parseMode: null };
    }

    let history = chatHistories[chatId] || [];

    if (history.length === 0) {
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
    console.log(`Calling Gemini API for chat ${chatId}. User: ${userName}. Prompt: "${newUserPrompt}". Grounding: ${enableGrounding}`);

    const requestBody = {
        systemInstruction: { parts: history.filter(h => h.role === 'system').flatMap(h => h.parts) },
        contents: history.filter(h => h.role === 'user' || h.role === 'model'),
        generationConfig: {
            temperature: 1.0,
            topP: 0.9,
        },
        // safetySettings: [ // Tambahkan jika sering kena safety block
        //     { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        //     { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        //     { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        //     { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
        // ]
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

        // Handle potential safety blocking first
        if (candidate?.finishReason === 'SAFETY') {
             console.warn(`Gemini response blocked due to SAFETY for chat ${chatId}. Prompt: "${newUserPrompt}"`);
             chatHistories[chatId] = historyBeforeResponse; // Rollback history
             return { text: `Waduh ${userName}, AI Gemini nggak bisa jawab karena ada isu keamanan konten. Coba tanya yang lain ya.`, parseMode: null };
        }

        // Check for function calls (grounding) vs regular text response
        if (candidate?.content?.parts?.[0]?.functionCall) {
            console.warn("Received functionCall, expected grounding results directly...");
             const textPart = candidate.content.parts.find(part => part.text);
             aiResponseText = textPart ? textPart.text : '';
             if (!aiResponseText) {
                 console.log("Function call received without accompanying text. Grounding data might be processed differently.");
                 aiResponseText = "(Hasil pencarian sedang diproses...)"; // Placeholder
             }
        } else {
            aiResponseText = candidate?.content?.parts?.[0]?.text;
        }

        const groundingAttributions = candidate?.citationMetadata?.citationSources;

        if (aiResponseText || (enableGrounding && groundingAttributions && groundingAttributions.length > 0)) {
             if (!aiResponseText) aiResponseText = "";
             else {
                 console.log("Gemini response text received.");
                 history.push({ role: "model", parts: [{ text: aiResponseText }] });
                 chatHistories[chatId] = history;
             }

            let finalResponseText = aiResponseText;
            let parseMode = null; // Selalu null

            if (groundingAttributions && groundingAttributions.length > 0) {
                console.log("Grounding attributions found:", JSON.stringify(groundingAttributions, null, 2));
                finalResponseText += "\n\nSumber:";
                const sources = groundingAttributions
                    .map(source => ({
                        uri: source.uri,
                        title: source.displayName || source.uri
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
                 if (aiResponseText.trim() === "" && sources.length > 0) {
                    finalResponseText = "Berikut beberapa sumber yang mungkin relevan:" + finalResponseText;
                 }

            } else if (enableGrounding) {
                console.log("Grounding was enabled, but no attributions found in response.");
            }

            return { text: finalResponseText.trim(), parseMode: null };

        } else if (candidate && !aiResponseText && !groundingAttributions) {
             // Kasus jika response ada tapi tidak ada teks atau sumber (mungkin finish reason lain?)
             console.warn("Gemini response received but content is empty or invalid. Finish Reason:", candidate?.finishReason, "Data:", JSON.stringify(response.data, null, 2));
             chatHistories[chatId] = historyBeforeResponse; // Rollback
             return { text: `Hmm ${userName}, AI Gemini ngasih respons aneh nih (${candidate?.finishReason || 'Tidak diketahui'}). Coba lagi ya.`, parseMode: null };
        } else {
            // Kasus jika tidak ada candidate sama sekali atau format tidak dikenal
            console.error("Gemini response format unexpected or empty text/grounding.", JSON.stringify(response.data, null, 2));
            chatHistories[chatId] = historyBeforeResponse; // Rollback
            return { text: "Waduh, AI Gemini lagi diem nih, nggak ngasih jawaban.", parseMode: null };
        }

    } catch (error) {
        console.error('Error calling Gemini API:', error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        chatHistories[chatId] = historyBeforeResponse; // Rollback
        let errorMsg = `Duh ${userName}, maaf banget nih, ada gangguan pas ngobrol sama AI Gemini. Coba lagi nanti ya.`;
        if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) { errorMsg = `Aduh ${userName}, kelamaan nih nunggu AI Gemini-nya, coba lagi aja`; }
        else if (error.response && error.response.status === 429) { errorMsg = `Waduh ${userName}, kebanyakan nanya nih ke Gemini, coba santai dulu bentar`; }
        else if (error.response && error.response.data && error.response.data.error) {
             // Cek error spesifik dari Gemini
             if (error.response.data.error.message.includes("Candidate was blocked due to SAFETY")) {
                 errorMsg = `Waduh ${userName}, AI Gemini nggak bisa jawab karena ada isu keamanan konten. Coba tanya yang lain ya.`;
             } else if (error.response.data.error.status === 'INVALID_ARGUMENT') {
                  errorMsg = `Waduh ${userName}, kayaknya ada yang salah sama format permintaannya ke Gemini nih. Coba cek lagi ya. (${error.response.data.error.message})`;
             } else {
                errorMsg = `Error dari AI Gemini (${error.response.data.error.code || error.response.status}): ${error.response.data.error.message || 'Gagal memproses'}. Coba cek lagi ${userName}`;
             }
        }
        return { text: errorMsg, parseMode: null };
    }
}
// --- Akhir Fungsi Gemini ---


// --- Handler Utama Vercel (DIUBAH bagian /voice) ---
module.exports = async (req, res) => {
    if (req.method !== 'POST') { return res.status(405).json({ error: 'Method Not Allowed' }); }
    res.status(200).send('OK'); // Respon cepat ke Telegram

    try {
        if (!req.body) {
            console.log('Received empty body');
            return;
        }

        console.log('Received update:', JSON.stringify(req.body, null, 2));
        const update = req.body;

        if (update.message && update.message.chat) {
            const chatId = update.message.chat.id;
            const message = update.message;
            const messageText = (message.text || '').trim();
            const chatType = message.chat.type;
            const messageId = message.message_id;
            const userId = message.from.id;
            const username = message.from.username;
            const firstName = message.from.first_name;

            let nickname = username ? userNicknames[username.toLowerCase()] : null;
            const nameForAIContext = nickname || firstName || (username ? `@${username}` : null) || `User_${userId}`;
            const nameForBotGreeting = nickname || firstName || (username ? `@${username}` : null) || 'kamu';

            if (messageText) {
                 const lowerCaseText = messageText.toLowerCase();
                 let messageIdToReply = messageId;

                // 1. Handle /clear command
                if (lowerCaseText === '/clear') {
                    if (chatHistories[chatId]) {
                        delete chatHistories[chatId];
                        await sendMessage(chatId, `Oke ${nameForBotGreeting}, history obrolan sudah dibersihkan!`, messageIdToReply);
                        console.log(`History cleared for chat ${chatId} by ${nameForAIContext} (${userId})`);
                    } else {
                        await sendMessage(chatId, `Hmm ${nameForBotGreeting}, belum ada history buat dihapus.`, messageIdToReply);
                    }
                    return;
                }

                // 2. Handle /voice command (DIPERBARUI)
                else if (lowerCaseText.startsWith('/voice ')) {
                    const textToSpeak = messageText.substring(7).trim();

                    if (!openai) {
                        await sendMessage(chatId, `Maaf ${nameForBotGreeting}, fitur /voice belum aktif karena konfigurasi OpenAI (API Key) belum ada.`, messageIdToReply);
                        return;
                    }
                    if (!textToSpeak) {
                        await sendMessage(chatId, `Oke ${nameForBotGreeting}, mau ngomong apa pakai /voice? Contoh:\n/voice halo semua, selamat pagi!`, messageIdToReply);
                        return;
                    }
                     if (textToSpeak.length > 4096) { // Batas input OpenAI TTS adalah 4096 karakter
                          await sendMessage(chatId, `Waduh ${nameForBotGreeting}, teksnya kepanjangan buat diubah jadi suara. Coba dipersingkat ya (maksimal 4096 karakter).`, messageIdToReply);
                          return;
                      }

                    console.log(`Processing /voice command from ${nameForAIContext} (${userId}) in chat ${chatId}. Text length: ${textToSpeak.length}`);
                    await sendMessage(chatId, `Oke ${nameForBotGreeting}, lagi coba bikin suaranya pakai model ${TTS_MODEL} (${TTS_VOICE})...`, messageIdToReply);
                     try {
                         await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'upload_voice' });
                     } catch (actionError) { console.warn("Could not send upload_voice action:", actionError.message); }

                    try {
                        console.log(`Calling OpenAI TTS: Model=${TTS_MODEL}, Voice=${TTS_VOICE}, Instructions Provided: ${!!TTS_INSTRUCTIONS}`);
                        const response = await openai.audio.speech.create({
                            model: TTS_MODEL,       // <-- Model gpt-4o-mini-tts
                            voice: TTS_VOICE,       // <-- Voice sage (atau pilihan lain)
                            input: textToSpeak,     // <-- Teks dari pengguna
                            instructions: TTS_INSTRUCTIONS, // <-- Instruksi gaya suara
                            response_format: "mp3"  // <-- Format output
                        });

                        const audioBuffer = Buffer.from(await response.arrayBuffer());
                        console.log(`Generated audio buffer size: ${audioBuffer.length} bytes`);

                        // Kirim audio
                        const captionText = `Suara untuk: "${textToSpeak.substring(0, 80)}${textToSpeak.length > 80 ? '...' : ''}"`;
                        await sendAudio(chatId, audioBuffer, messageIdToReply, captionText); // Caption + pemberitahuan AI ditangani di sendAudio

                    } catch (error) {
                         console.error('Error calling OpenAI TTS API or processing audio:', error.response ? JSON.stringify(error.response.data, null, 2) : error); // Log error lebih detail
                         let errorMsg = `Aduh ${nameForBotGreeting}, maaf banget, gagal bikin suaranya nih.`;
                         if (error.response && error.response.data && error.response.data.error) {
                             // Coba parse error dari OpenAI
                             errorMsg += `\nDetail: [${error.response.data.error.type || 'OpenAI Error'}] ${error.response.data.error.message || JSON.stringify(error.response.data.error)}`;
                         } else if (error.message) {
                             errorMsg += `\nDetail: ${error.message}`;
                         } else {
                             errorMsg += "\nError tidak diketahui.";
                         }
                        await sendMessage(chatId, errorMsg, messageIdToReply);
                    }
                    return; // Selesai proses untuk /voice
                }

                // 3. Handle Gemini AI processing (TETAP SAMA)
                else {
                    let shouldProcessAI = false;
                    let promptForAI = "";
                    let enableGrounding = false;
                    let BOT_USER_ID = BOT_TOKEN ? parseInt(BOT_TOKEN.split(':')[0], 10) : null;

                    // Cek /info
                    if (lowerCaseText.startsWith('/info ')) {
                        promptForAI = messageText.substring(6).trim();
                        if (promptForAI) {
                            shouldProcessAI = true;
                            enableGrounding = true;
                            console.log(`Processing message ${messageId} WITH grounding from ${nameForAIContext} (${userId})`);
                        } else {
                            await sendMessage(chatId, `Iya ${nameForBotGreeting}, mau cari info apa pakai /info? Contoh: /info berita terkini tentang AI`, messageIdToReply);
                        }
                    }
                    // Cek trigger lain
                    else if (chatType === 'private') {
                        shouldProcessAI = true;
                        promptForAI = messageText;
                        enableGrounding = false;
                        console.log(`Processing private message ${messageId} (no grounding) from ${nameForAIContext} (${userId})`);
                    } else if (chatType === 'group' || chatType === 'supergroup') {
                        let triggerWord = null;
                        const triggers = ['/chat ', 'bot ', 'tanya '];
                        for (const trig of triggers) {
                            if (lowerCaseText.startsWith(trig)) {
                                triggerWord = trig;
                                promptForAI = messageText.substring(triggerWord.length).trim();
                                break;
                            }
                        }

                        if (!triggerWord && BOT_USER_ID && message.reply_to_message?.from?.id === BOT_USER_ID) {
                            triggerWord = 'reply_to_bot';
                            promptForAI = messageText;
                        }

                        // Konteks balasan
                        if (triggerWord && message.reply_to_message && message.reply_to_message.text) {
                            const repliedText = message.reply_to_message.text;
                             // Hindari memasukkan nama pengguna asli ke konteks jika itu adalah bot itu sendiri
                             let originalSenderName = `User ${message.reply_to_message.from.id}`;
                             if (!message.reply_to_message.from.is_bot) {
                                 originalSenderName = message.reply_to_message.from.first_name || (message.reply_to_message.from.username ? `@${message.reply_to_message.from.username}` : `User ${message.reply_to_message.from.id}`);
                             } else if (message.reply_to_message.from.id === BOT_USER_ID) {
                                 originalSenderName = "pesanmu sebelumnya"; // Atau "your previous message"
                             } else {
                                 originalSenderName = "bot lain"; // Atau "another bot"
                             }

                            promptForAI = `(Konteks: Kamu sedang membalas ${originalSenderName} yang isinya: "${repliedText}")\n\nPertanyaan/pernyataan saya: "${promptForAI}"`;
                            console.log(`Added context from replied message ${message.reply_to_message.message_id}`);
                        }

                        if (triggerWord && promptForAI) {
                            shouldProcessAI = true;
                            enableGrounding = false;
                            console.log(`Trigger '${triggerWord.trim()}' activated (no grounding) for message ${messageId} in group ${chatId} by ${nameForAIContext} (${userId})`);
                        } else if (triggerWord && !promptForAI && triggerWord !== 'reply_to_bot') {
                            let helpText = `Iya ${nameForBotGreeting}? Mau nanya apa nih? Contoh: ${triggerWord.trim()} jelaskan soal black hole`;
                            await sendMessage(chatId, helpText, messageIdToReply);
                        } else if (!triggerWord) {
                             console.log(`Ignoring non-trigger message ${messageId} in group chat ${chatId} from ${nameForAIContext} (${userId})`);
                        }
                    } else {
                        console.log(`Ignoring message from unsupported chat type: ${chatType}`);
                    }

                    // Proses AI Gemini jika diperlukan
                    if (shouldProcessAI) {
                         if (!promptForAI) {
                             console.warn(`shouldProcessAI is true but promptForAI is empty for message ${messageId}`);
                             await sendMessage(chatId, `Hmm ${nameForBotGreeting}, sepertinya ada yang aneh. Coba ulangi pertanyaannya?`, messageIdToReply);
                         } else if (promptForAI.length > 3000) { // Batas aman untuk input Gemini (bisa lebih tinggi tergantung model)
                            await sendMessage(chatId, `Waduh ${nameForBotGreeting}, pertanyaannya panjang banget buat Gemini. Coba dipersingkat ya (maksimal 3000 karakter).`, messageIdToReply);
                        } else {
                            try {
                                await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action: 'typing' });
                            } catch (actionError) { console.warn("Could not send typing action:", actionError.message); }

                            const aiResponseObject = await getGeminiResponse(chatId, promptForAI, nameForAIContext, enableGrounding);
                            await sendMessage(chatId, aiResponseObject.text, messageIdToReply);
                        }
                    }
                }
            } else {
                 console.log(`Ignoring non-text message update in chat ${chatId} (message ID: ${messageId})`);
             }

        } else {
            console.log('Ignoring update that is not a message or lacks required fields.');
        }
    } catch (error) {
        console.error("Error processing update:", error);
        // Pertimbangkan mengirim notifikasi error ke admin di sini jika perlu
    }
};