# Speech recognition vocabulary

`cybersecurity_hotwords.txt` contains spoken English words and phrases that the local streaming recognizer is encouraged to hear accurately. The list covers threats, attacks, identity, network security, cryptography, application security, incident response, cloud security, tools, and common acronyms. It is broad and editable; cybersecurity vocabulary continues to change, so it cannot include every possible term.

To add a term, put it on its own line. Use English letters and spaces, write numbers as words, and spell out acronyms as spoken letters (for example, `C V E`). Lines beginning with `#` are comments. Restart Jarvis to load changes. Up to 2,000 distinct phrases are supported.

These are statistical hints, not a guarantee: the recognizer can still make mistakes, and a hint can occasionally make it choose the wrong word. Jarvis uses conversational and screen context to interpret a request and asks for clarification when an exact detail matters. Set `JARVIS_CYBER_HOTWORDS=0` before starting Jarvis to disable the hints and use the faster general-purpose decoder.

`zipformer-bpe.vocab` is the byte-pair vocabulary exported from the `bpe.model` in the [Zipformer model repository](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26), revision `672fbf1b30579d6585301139bb363f42a0ad4a24`. That model is published under the Apache License 2.0. The vocabulary lets Sherpa-ONNX encode the editable phrases without installing another tokenizer.
