# Jarvis

Jarvis is a voice assistant inspired by J.A.R.V.I.S. from *Iron Man*. Talk to it naturally, share your screen, and hear its replies. You can interrupt it, type a message, or return to an earlier conversation.

Your speech is transcribed locally using the 0.6B **Underdog Bark 3.0** model. Jarvis uses **Dots3-Note Preview** for answers and **Fish Audio S2.1 Pro Free** for speech through OpenRouter.

## Quick start on Windows

1. Create an account or sign in at [OpenRouter](https://openrouter.ai/).
2. Open [API Keys](https://openrouter.ai/settings/keys), select **Create Key**, name it `Jarvis`, and copy the key. Keep it private.
3. On this GitHub page, select **Code → Download ZIP**, then extract the ZIP file.
4. Open the extracted folder and double-click **Jarvis.cmd**. The first setup downloads the speech model and can take a while.
5. When prompted, paste your OpenRouter key and select **Prepare Jarvis**. Jarvis remembers it securely for later starts when your computer's credential store is available. Keep the command window open while the model loads; your default browser will open when it is ready.
6. Select **Start Jarvis**, choose **Entire Screen** when asked to share, and allow microphone access.

For macOS and Linux, see [Start Jarvis](#3-start-jarvis) below. More detailed instructions and troubleshooting are also below.

## Before you begin

You need:

- A computer with a microphone, an internet connection, and several gigabytes of free disk space.
- A recent browser such as Firefox, Edge, or Chrome.
- A free OpenRouter account and API key. The next section shows you how to make one.

The first setup downloads the speech model and its dependencies. It can take a while. Later starts reuse those files, but the model still needs time to load before the browser opens.

## 1. Create an OpenRouter API key

1. Go to [OpenRouter](https://openrouter.ai/) and create an account or sign in.
2. Open the [API keys page](https://openrouter.ai/settings/keys).
3. Choose **Create Key**, give it a name such as `Jarvis`, and create it.
4. Copy the key and save it somewhere private, such as a password manager. OpenRouter may show it only once.
5. Keep it ready for the Jarvis startup prompt. **Do not post your key or share it with anyone.**

Jarvis selects free OpenRouter models. Free models have usage limits and can become unavailable; check [OpenRouter's pricing and limits](https://openrouter.ai/pricing) for current details. An API key is still required.

## 2. Download Jarvis

On this GitHub page, select **Code → Download ZIP**. Extract the ZIP file and open the extracted `Jarvis` folder.

If you use Git, you can also clone this repository:

```sh
git clone https://github.com/ScientificAJ/Jarvis.git
```

## 3. Start Jarvis

### Windows

1. Double-click **Jarvis.cmd** in the extracted folder.
2. On the first run, wait for setup to download the local speech model and its dependencies.
3. When prompted, paste your OpenRouter API key and select **Prepare Jarvis**. On later starts, Jarvis uses the saved key automatically when secure storage is available.
4. Keep the command window open while the model loads. Your default browser opens when Jarvis is ready.

Windows setup installs a private Python runtime in the Jarvis folder; you do not need to install Python separately.

### macOS and Linux

1. Install 64-bit Python **3.11, 3.12, or 3.13**, including its `venv` support.
2. Open a terminal, type `cd `, drag the extracted `Jarvis` folder into the terminal, and press Enter.
3. Run:

   ```sh
   bash Jarvis.sh
   ```

4. Wait for first-time setup, enter your OpenRouter API key when prompted, and keep the terminal open until the browser opens. Jarvis uses the saved key on later starts when a secure credential store is available.

The macOS launcher supports **Apple-silicon Macs**; Intel Macs are not supported by the required PyTorch version. On Linux ARM, first install Git and a current Rust toolchain so the speech decoder can be built.

## 4. Talk to Jarvis

1. Select **Start Jarvis** on the page.
2. In the browser's sharing prompt, choose **Entire Screen** and select **Share**. You can choose a single window instead if you prefer.
3. Allow microphone access when your browser asks.
4. Speak naturally. After about two seconds of silence, Jarvis finishes the request and answers aloud. For longer answers, it starts speaking a short section while preparing the next one. You can speak to interrupt it.

Use the microphone and screen buttons to turn them on or off. Select **New chat** to start again or **History** to open a previous conversation. You can also type in the message box. Close the command or terminal window to stop Jarvis.

## How your information is used

- **Your voice:** Speech is transcribed on your computer in chunks of at most 15 seconds. During a pause, transcription can start early; the request is submitted after about two seconds of silence. Bark 3.0 recognizes English.
- **Your screen:** The preview is live. When you ask something, Jarvis sends selected, time-ordered screen images to OpenRouter—not a continuous video. It can include a small amount of screen context from the previous turn. Brief changes or small text may be missed. Turning screen sharing off prevents pending or retained images from being sent; images already sent cannot be withdrawn.
- **Your messages:** Your request, relevant conversation history, personal preferences, and selected screen images are sent to OpenRouter and its model provider. The answer is sent to OpenRouter for speech synthesis.
- **Your key and chats:** Jarvis saves an entered key in Windows Credential Manager, macOS Keychain, or a Linux Secret Service when available, and uses it in the local server while running. It does not save the key in the project or a temporary file. Chats and personal settings are stored in your browser on your computer. A key saved by an older version of Jarvis may remain in browser storage until you save Settings again or clear the site's data.

To remove the saved key, open a terminal in the Jarvis folder and run `Jarvis.cmd --forget-key` on Windows or `bash Jarvis.sh --forget-key` on macOS/Linux. Jarvis will ask for a key on the next start. If you set `OPENROUTER_API_KEY` yourself, remove that environment variable separately.

## Troubleshooting

**The browser did not open.** Keep the command window open and wait for the model to finish loading. If an error appears, check your internet connection and available disk space, then start Jarvis again.

**Jarvis cannot see my screen.** Turn on **Screen**, choose **Entire Screen**, and allow the browser's sharing prompt. On macOS, you may also need to allow your browser under **System Settings → Privacy & Security → Screen & System Audio Recording**. Linux screen sharing depends on your browser and desktop environment.

**Jarvis cannot hear me, interrupts itself, or misses my interruption.** Check your microphone permission and adjust **Microphone sensitivity** in Settings. Headphones can help reduce speaker echo. You can also use **Stop response**.

**Jarvis keeps listening after I stop speaking.** Background noise may be keeping the microphone active. Choose **Low** microphone sensitivity in Settings or turn the microphone off to finish the current request. Try typing a message to check whether the online answer service is working.

**There is no spoken reply.** Try **Speak last answer**. If OpenRouter reports a key or rate-limit error, check your key and try again later.

**The model is slow.** Bark expands its weights in memory and may need several gigabytes of RAM. Close other memory-heavy applications and try again. The local model is loaded and warmed before the browser opens, and chunks can be transcribed while you are speaking or pausing. On some computers, transcription takes longer than the speech itself; CPU speed and available memory make a large difference.

On a CPU, Jarvis normally uses a compact, lower-precision version of the same Bark model to save memory and improve speed. Transcripts can differ slightly from full precision. To prefer full precision, set the environment variable `JARVIS_CPU_QUANTIZE` to `0` before starting Jarvis; it may be much slower. If compact mode is unsupported, Jarvis falls back to full precision automatically.

**Jarvis asks for my key every time.** Check the command window for a secure-storage warning. On Linux, install `secret-tool` and make sure your desktop's Secret Service or keyring is running and unlocked. If a secure store is unavailable, Jarvis uses the key for the current session only rather than saving it in plain text.

**A free model is unavailable.** Free models can be rate-limited or removed. OpenRouter currently lists Dots3-Note Preview as expiring on **December 31, 2026**. Jarvis does not automatically switch to a paid model.

## A few limits

Jarvis is an AI assistant and can make mistakes. It can discuss the text and screen images you provide, but it does not browse the web, control your computer, or inspect files on its own. Fish Audio's provider-selected voice may not match the film character.

The Bark model is downloaded from [Conway Research](https://huggingface.co/ConwayResearch/Underdog-Bark-3.0); its attribution is kept with the downloaded model.
