/**
 * The microphone tap for native dictation: every rendering quantum of mono
 * audio, posted to the window as it arrives.
 *
 * **Plain JS in `static/`, deliberately outside Vite** — the same call
 * `static/tts/sherpa-worker.js` documents, for a second reason on top of that
 * one. `AudioWorklet.addModule` takes a URL and evaluates the file in a scope
 * that has no `window`, no `import` of anything the bundler would rewrite, and
 * a global (`registerProcessor`) that only exists there; a bundled worklet is a
 * chunk graph waiting to diverge between dev and build for no benefit at all.
 * This file is eleven lines and has no dependencies.
 *
 * **It has no output, and that is the whole point of the shape.** The node is
 * built with `numberOfOutputs: 0` (`src/lib/asr/native.ts`), so the capture
 * graph never reaches `AudioContext.destination` and no output device is opened
 * — which matters on the Tauri desktop, where WebKitGTK's Web Audio *output* is
 * measured to play noise or silence (`docs/desktop.md`). A recorder that had to
 * connect itself to the speakers to be pulled would be the one shape that could
 * make a noise while the learner is talking.
 *
 * The samples are `Float32Array` in [-1, 1] at the context's own rate; framing
 * them into 16 kHz 16-bit PCM is `src/lib/asr/pcm.ts`'s job, on the window
 * thread where it can be unit-tested.
 */

class PcmCollector extends AudioWorkletProcessor {
	process(inputs) {
		const channel = inputs[0]?.[0];
		// A quantum with no input is an ordinary thing while the graph settles;
		// `slice()` because the buffer handed in is reused for the next one.
		if (channel && channel.length > 0) this.port.postMessage(channel.slice());
		// Never done: the node is torn down by the window, not by itself.
		return true;
	}
}

registerProcessor('pcm-collector', PcmCollector);
