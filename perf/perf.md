# 大文档性能剖析(Chromium,不压缩的生产构建)

## 规模与耗时

```json
[
  {
    "kb": 256,
    "blocks": 2792,
    "parseMs": 270,
    "openMs": 125,
    "loadedMs": 363,
    "closeMs": 7
  },
  {
    "kb": 512,
    "blocks": 5556,
    "parseMs": 339,
    "openMs": 83,
    "loadedMs": 553,
    "closeMs": 7
  },
  {
    "kb": 1024,
    "blocks": 11036,
    "parseMs": 610,
    "openMs": 86,
    "loadedMs": 1036,
    "closeMs": 13
  },
  {
    "kb": 2048,
    "blocks": 21998,
    "parseMs": 1352,
    "openMs": 123,
    "loadedMs": 1882,
    "closeMs": 17
  },
  {
    "kb": 5120,
    "blocks": 54678,
    "parseMs": 2669,
    "openMs": 86,
    "loadedMs": 4366,
    "closeMs": 43
  }
]
```

剖析文档 1048798 字节,11036 个顶层块

```json
{
  "parseMs": 629,
  "openMs": {
    "firstScreen": 88,
    "loaded": 988
  },
  "input": {
    "total": {
      "p50": 1.2,
      "p95": 2.8,
      "max": 5.1
    },
    "dispatch": {
      "p50": 1.1,
      "p95": 2.7,
      "max": 4.5
    }
  },
  "switchBackMs": 49
}
```

## WebKit 规模与耗时

```json
[
  {
    "kb": 64,
    "blocks": 704,
    "parseMs": 119,
    "openMs": 210,
    "loadedMs": 210,
    "closeMs": 11
  },
  {
    "kb": 128,
    "blocks": 1402,
    "parseMs": 142,
    "openMs": 124,
    "loadedMs": 357,
    "closeMs": 16
  },
  {
    "kb": 256,
    "blocks": 2792,
    "parseMs": 234,
    "openMs": 131,
    "loadedMs": 499,
    "closeMs": 12
  },
  {
    "kb": 512,
    "blocks": 5556,
    "parseMs": 471,
    "openMs": 122,
    "loadedMs": 867,
    "closeMs": 23
  },
  {
    "kb": 1024,
    "blocks": 11036,
    "parseMs": 906,
    "openMs": 146,
    "loadedMs": 1793,
    "closeMs": 38
  },
  {
    "kb": 2048,
    "blocks": 21998,
    "parseMs": 1841,
    "openMs": 128,
    "loadedMs": 2951,
    "closeMs": 51
  },
  {
    "kb": 5120,
    "blocks": 54678,
    "parseMs": 5073,
    "openMs": 181,
    "loadedMs": 10194,
    "closeMs": 118
  }
]
```

## 启动 · 到编辑器就绪 412 毫秒

| 脚本 | KB | 启动时执行过 KB |
|---|---|---|
| /assets/rolldown-runtime-DbVrKiKs.js | 2 | 1 |
| /assets/dist-CmDfL8fU.js | 585 | 160 |
| /assets/index-3bPuAcfn.js | 2484 | 1014 |
| /assets/demo-DEtO0BR2.js | 2 | 2 |
| /assets/memory-Be1n-XrM.js | 41 | 10 |
| /assets/mhchem-k8Vdd0Me.js | 55 | 24 |
| /assets/katex-BEPN8FI0.js | 485 | 326 |

## 启动 · 加载了没执行的模块 Top

| 模块 | KB | 没执行 KB |
|---|---|---|
| @codemirror/view | 312 | 256 |
| katex | 540 | 189 |
| src/app | 241 | 170 |
| yaml | 198 | 164 |
| prosemirror-view | 175 | 115 |
| src/core | 161 | 102 |
| src/plugins | 138 | 96 |
| src/ai | 104 | 90 |
| @codemirror/state | 115 | 75 |
| prosemirror-tables | 69 | 56 |
| micromark-core-commonmark | 91 | 51 |
| prosemirror-transform | 65 | 49 |
| src/views | 65 | 49 |
| @lezer/markdown | 65 | 49 |
| @lezer/common | 62 | 45 |
| dompurify | 84 | 42 |
| mdast-util-to-markdown | 77 | 41 |
| prosemirror-model | 96 | 40 |
| @codemirror/language | 58 | 37 |
| @codemirror/commands | 62 | 37 |
| @lezer/lr | 48 | 37 |
| src/host | 46 | 36 |
| @codemirror/search | 39 | 31 |
| src/ui | 27 | 23 |
| @codemirror/language-data | 32 | 18 |
| prosemirror-commands | 22 | 16 |
| @codemirror/lang-markdown | 17 | 14 |
| prosemirror-state | 29 | 11 |
| micromark-extension-gfm-autolink-literal | 15 | 10 |
| vfile | 23 | 9 |

## 热点源码 · subtokenize /assets/index-3bPuAcfn.js:24776

所属:node_modules/micromark-util-subtokenize/index.js

```js
*   Whether subtokens were found.
*/
function subtokenize(eventsArray) {
	/** @type {Record<string, number>} */
	const jumps = {};
	let index = -1;
	/** @type {Event} */
	let event;
	/** @type {number | undefined} */
	let lineIndex;
	/** @type {number} */
	let otherIndex;
	/** @type {Event} */
	let otherEvent;
	/** @type {Array<Event>} */
```

## 热点源码 · compile /assets/index-3bPuAcfn.js:32174

所属:node_modules/mdast-util-from-markdown/lib/index.js

```js
	*   mdast tree.
	*/
	function compile(events) {
		/** @type {Root} */
		let tree = {
			type: "root",
			children: [],
			position: void 0
		};
		/** @type {Omit<CompileContext, 'sliceSerialize'>} */
		const context = {
			stack: [tree],
			tokenStack: [],
			config,
			enter,
```

## 热点源码 · subcontent /assets/index-3bPuAcfn.js:24850

所属:node_modules/micromark-util-subtokenize/index.js

```js
*   Gaps.
*/
function subcontent(events, eventIndex) {
	const token = events.get(eventIndex)[1];
	const context = events.get(eventIndex)[2];
	let startPosition = eventIndex - 1;
	/** @type {Array<number>} */
	const startPositions = [];
	let tokenizer = token._tokenizer;
	if (!tokenizer) {
		tokenizer = context.parser[token.contentType](token.start);
		if (token._contentTypeTextTrailing) tokenizer._contentTypeTextTrailing = true;
	}
	const childEvents = tokenizer.events;
	/** @type {Array<[number, number]>} */
```

## 热点源码 · start /assets/index-3bPuAcfn.js:31608

所属:node_modules/micromark/lib/create-tokenizer.js

```js
				return start;
				/** @type {State} */
				function start(code) {
					info = store();
					currentConstruct = construct;
					if (!construct.partial) context.currentConstruct = construct;
					if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) return nok(code);
					return construct.tokenize.call(fields ? Object.assign(Object.create(context), fields) : context, effects, ok, nok)(code);
				}
			}
			/** @type {State} */
			function ok(code) {
				onreturn(currentConstruct, info);
				return returnState;
			}
```

## 启动 · 自耗时 Top

| 毫秒 | 函数 |
|---|---|
| 105.4 | (idle) :0 |
| 100.9 | (program) :0 |
| 58.8 | (匿名) /assets/dist-CmDfL8fU.js:105 |
| 25.6 | setDocument /assets/index-3bPuAcfn.js:78626 |
| 9.7 | (garbage collector) :0 |
| 6.7 | (匿名) /assets/index-3bPuAcfn.js:1 |
| 3.8 | (匿名) /assets/memory-Be1n-XrM.js:1232 |
| 3.7 | decodeArray /assets/index-3bPuAcfn.js:71991 |
| 3.5 | computeBox :3181 |
| 2.4 | (匿名) /assets/dist-CmDfL8fU.js:1 |
| 2.3 | computeElementStyleVisibilityVisible :3155 |
| 1.9 | h /assets/index-3bPuAcfn.js:6622 |
| 1.3 | start /assets/index-3bPuAcfn.js:31608 |
| 1.1 | Facet /assets/dist-CmDfL8fU.js:1525 |
| 1.1 | (匿名) /assets/katex-BEPN8FI0.js:1 |
| 1.1 | boot /assets/index-3bPuAcfn.js:80060 |
| 1.1 | query :5816 |
| 1 | (匿名) /assets/mhchem-k8Vdd0Me.js:1 |
| 1 | compile /assets/index-3bPuAcfn.js:32174 |
| 1 | resourceURL /assets/memory-Be1n-XrM.js:1176 |
| 0.9 | evaluate :364 |
| 0.8 | pastePlugin /assets/index-3bPuAcfn.js:49978 |
| 0.8 | createMemoryHost /assets/memory-Be1n-XrM.js:1054 |
| 0.8 | init /assets/index-3bPuAcfn.js:78481 |
| 0.8 | (匿名) :2 |
| 0.7 | countWords /assets/index-3bPuAcfn.js:47741 |
| 0.7 | create /assets/index-3bPuAcfn.js:7852 |
| 0.7 | toNode /assets/katex-BEPN8FI0.js:777 |
| 0.6 | buildPlugins /assets/index-3bPuAcfn.js:56766 |
| 0.5 | createTokenType /assets/dist-CmDfL8fU.js:16973 |
| 0.5 | LRParser /assets/index-3bPuAcfn.js:72791 |
| 0.5 | createEditorState /assets/index-3bPuAcfn.js:56805 |
| 0.5 | updateChildren /assets/index-3bPuAcfn.js:7910 |
| 0.5 | updatePluginViews /assets/index-3bPuAcfn.js:11178 |
| 0.5 | createElementNS :0 |
| 0.5 | addToSet /assets/index-3bPuAcfn.js:43056 |
| 0.5 | renderTree /assets/index-3bPuAcfn.js:68513 |
| 0.5 | InjectedScript :6969 |
| 0.5 | now /assets/index-3bPuAcfn.js:31424 |
| 0.5 | go /assets/index-3bPuAcfn.js:31468 |

## 启动 · 含子调用 Top

| 毫秒 | 函数 |
|---|---|
| 388.3 | (root) :0 |
| 105.4 | (idle) :0 |
| 100.9 | (program) :0 |
| 63.9 | (匿名) /assets/dist-CmDfL8fU.js:1 |
| 58.8 | (匿名) /assets/dist-CmDfL8fU.js:105 |
| 37.1 | openFile /assets/index-3bPuAcfn.js:78689 |
| 32.1 | setDocument /assets/index-3bPuAcfn.js:78626 |
| 18.2 | (匿名) /assets/index-3bPuAcfn.js:1 |
| 14.3 | loadProgressive /assets/index-3bPuAcfn.js:63706 |
| 13.5 | nextBlocks /assets/index-3bPuAcfn.js:36242 |
| 12.9 | init /assets/index-3bPuAcfn.js:78481 |
| 11.8 | (匿名) :1 |
| 10.9 | parse /assets/index-3bPuAcfn.js:35004 |
| 9.8 | fromMarkdown /assets/index-3bPuAcfn.js:32042 |
| 9.8 | parser /assets/index-3bPuAcfn.js:33049 |
| 9.7 | (garbage collector) :0 |
| 9.4 | evaluate :364 |
| 9.2 | createEditorView /assets/index-3bPuAcfn.js:56811 |
| 9.2 | newView /assets/index-3bPuAcfn.js:78609 |
| 9 | EditorView /assets/index-3bPuAcfn.js:10997 |
| 6.5 | docViewDesc /assets/index-3bPuAcfn.js:8012 |
| 6.4 | write /assets/index-3bPuAcfn.js:31407 |
| 6.2 | updateChildren /assets/index-3bPuAcfn.js:7910 |
| 6.1 | go /assets/index-3bPuAcfn.js:31468 |
| 6.1 | main /assets/index-3bPuAcfn.js:31450 |

## 解析 · 自耗时 Top

| 毫秒 | 函数 |
|---|---|
| 420.8 | (program) :0 |
| 128.8 | subtokenize /assets/index-3bPuAcfn.js:24776 |
| 101 | compile /assets/index-3bPuAcfn.js:32174 |
| 91.4 | (garbage collector) :0 |
| 37.2 | subcontent /assets/index-3bPuAcfn.js:24850 |
| 33.8 | start /assets/index-3bPuAcfn.js:31608 |
| 16 | onexitdata /assets/index-3bPuAcfn.js:32592 |
| 11.7 | splice /assets/index-3bPuAcfn.js:22031 |
| 11.7 | data /assets/index-3bPuAcfn.js:31091 |
| 10.6 | set webkitSpeechRecognitionEvent :0 |
| 9.5 | writeToChild /assets/index-3bPuAcfn.js:30926 |
| 8.5 | flowContinue /assets/index-3bPuAcfn.js:30901 |
| 8.5 | write /assets/index-3bPuAcfn.js:31407 |
| 8.5 | splice /assets/index-3bPuAcfn.js:24647 |
| 6.4 | enter /assets/index-3bPuAcfn.js:32397 |
| 5.3 | resolveAllAttention /assets/index-3bPuAcfn.js:22905 |
| 5.3 | nextBlocks /assets/index-3bPuAcfn.js:36242 |
| 5.3 | type /assets/index-3bPuAcfn.js:16287 |
| 4.3 | inlines /assets/index-3bPuAcfn.js:36505 |
| 4.3 | data /assets/index-3bPuAcfn.js:30757 |
| 3.2 | prepareList /assets/index-3bPuAcfn.js:32262 |
| 3.2 | postprocess /assets/index-3bPuAcfn.js:31816 |
| 3.2 | paragraphInitial /assets/index-3bPuAcfn.js:30742 |
| 3.2 | sliceChunks /assets/index-3bPuAcfn.js:31697 |
| 3.2 | check /assets/index-3bPuAcfn.js:16303 |
| 3.2 | resolveHeadingAtx /assets/index-3bPuAcfn.js:25845 |
| 3.2 | prefix /assets/index-3bPuAcfn.js:23348 |
| 3.2 | headDelimiterStart /assets/index-3bPuAcfn.js:29468 |
| 3.2 | start /assets/index-3bPuAcfn.js:31577 |
| 3.2 | createTokenizer /assets/index-3bPuAcfn.js:31351 |
| 3.2 | chunkInside /assets/index-3bPuAcfn.js:24987 |
| 3.2 | transformFlow /assets/index-3bPuAcfn.js:35812 |
| 3.2 | documentContinue /assets/index-3bPuAcfn.js:30824 |
| 2.1 | collectDefinitions /assets/index-3bPuAcfn.js:36395 |
| 2.1 | slice /assets/index-3bPuAcfn.js:24620 |
| 2.1 | fromMarkdown /assets/index-3bPuAcfn.js:32042 |
| 2.1 | initializeFlow /assets/index-3bPuAcfn.js:31011 |
| 2.1 | accountForPotentialSkip /assets/index-3bPuAcfn.js:31680 |
| 2.1 | headRowData /assets/index-3bPuAcfn.js:29429 |
| 2.1 | notText /assets/index-3bPuAcfn.js:31081 |

## 解析 · 含子调用 Top

| 毫秒 | 函数 |
|---|---|
| 1053.1 | (root) :0 |
| 539.6 | parseMarkdown /assets/index-3bPuAcfn.js:36309 |
| 539.6 | (匿名) :1 |
| 539.6 | evaluate :364 |
| 534.2 | nextBlocks /assets/index-3bPuAcfn.js:36242 |
| 512.9 | fromMarkdown /assets/index-3bPuAcfn.js:32042 |
| 512.9 | parser /assets/index-3bPuAcfn.js:33049 |
| 512.9 | parse /assets/index-3bPuAcfn.js:35004 |
| 420.8 | (program) :0 |
| 253.2 | subtokenize /assets/index-3bPuAcfn.js:24776 |
| 231.9 | postprocess /assets/index-3bPuAcfn.js:31816 |
| 151.1 | compile /assets/index-3bPuAcfn.js:32174 |
| 126.7 | write /assets/index-3bPuAcfn.js:31407 |
| 113.7 | subcontent /assets/index-3bPuAcfn.js:24850 |
| 91.4 | (garbage collector) :0 |
| 56.4 | writeToChild /assets/index-3bPuAcfn.js:30926 |
| 41.2 | start /assets/index-3bPuAcfn.js:31608 |
| 37.3 | flowContinue /assets/index-3bPuAcfn.js:30901 |
| 34.1 | onsuccessfulconstruct /assets/index-3bPuAcfn.js:31522 |
| 30.9 | thereIsNoNewContainer /assets/index-3bPuAcfn.js:30868 |
| 25.6 | resolveContent /assets/index-3bPuAcfn.js:24949 |
| 25.6 | contentEnd /assets/index-3bPuAcfn.js:24998 |
| 23.2 | data /assets/index-3bPuAcfn.js:31091 |
| 22.3 | documentContinue /assets/index-3bPuAcfn.js:30824 |
| 16 | onexitdata /assets/index-3bPuAcfn.js:32592 |

## 打开并渲染 · 自耗时 Top

| 毫秒 | 函数 |
|---|---|
| 420.1 | (program) :0 |
| 123.8 | subtokenize /assets/index-3bPuAcfn.js:24776 |
| 122.9 | (garbage collector) :0 |
| 105.9 | compile /assets/index-3bPuAcfn.js:32174 |
| 45 | rebuildHeights /assets/index-3bPuAcfn.js:51339 |
| 38.3 | start /assets/index-3bPuAcfn.js:31608 |
| 29.8 | subcontent /assets/index-3bPuAcfn.js:24850 |
| 22.8 | appendHeights /assets/index-3bPuAcfn.js:51348 |
| 20.2 | setDocument /assets/index-3bPuAcfn.js:78626 |
| 15.3 | onexitdata /assets/index-3bPuAcfn.js:32592 |
| 14.1 | writeToChild /assets/index-3bPuAcfn.js:30926 |
| 14 | nodesBetween /assets/index-3bPuAcfn.js:208 |
| 13.9 | splice /assets/index-3bPuAcfn.js:22031 |
| 13.2 | data /assets/index-3bPuAcfn.js:31091 |
| 12.8 | createTextNode :0 |
| 11.7 | countWords /assets/index-3bPuAcfn.js:47741 |
| 10.6 | set webkitSpeechRecognitionEvent :0 |
| 9.7 | create /assets/index-3bPuAcfn.js:7852 |
| 9.6 | write /assets/index-3bPuAcfn.js:31407 |
| 8.7 | (idle) :0 |
| 8.6 | createTokenizer /assets/index-3bPuAcfn.js:31351 |
| 8.5 | headRowData /assets/index-3bPuAcfn.js:29429 |
| 7.8 | addNode /assets/index-3bPuAcfn.js:8362 |
| 7.6 | insertBefore :0 |
| 7.5 | splice /assets/index-3bPuAcfn.js:24647 |
| 7.5 | renderDescs /assets/index-3bPuAcfn.js:8119 |
| 7.4 | get nextSibling :0 |
| 5.5 | check /assets/index-3bPuAcfn.js:16303 |
| 5.4 | rescan /assets/index-3bPuAcfn.js:47308 |
| 5.3 | createElement :0 |
| 5.3 | suspiciousAttributes /assets/index-3bPuAcfn.js:3037 |
| 4.4 | slice /assets/index-3bPuAcfn.js:24620 |
| 4.3 | syncToMarks /assets/index-3bPuAcfn.js:8238 |
| 4.3 | refresh /assets/index-3bPuAcfn.js:51395 |
| 4.3 | sliceChunks /assets/index-3bPuAcfn.js:31697 |
| 4.3 | resolveAllAttention /assets/index-3bPuAcfn.js:22905 |
| 4.3 | nextBlocks /assets/index-3bPuAcfn.js:36242 |
| 4.3 | block /assets/index-3bPuAcfn.js:36420 |
| 4.2 | thereIsNoNewContainer /assets/index-3bPuAcfn.js:30868 |
| 3.4 | postprocess /assets/index-3bPuAcfn.js:31816 |

## 打开并渲染 · 含子调用 Top

| 毫秒 | 函数 |
|---|---|
| 1343.9 | (root) :0 |
| 720.6 | step /assets/index-3bPuAcfn.js:78657 |
| 546.2 | nextBlocks /assets/index-3bPuAcfn.js:36242 |
| 522.6 | fromMarkdown /assets/index-3bPuAcfn.js:32042 |
| 522.6 | parser /assets/index-3bPuAcfn.js:33049 |
| 522.6 | parse /assets/index-3bPuAcfn.js:35004 |
| 420.1 | (program) :0 |
| 242.2 | subtokenize /assets/index-3bPuAcfn.js:24776 |
| 231.6 | postprocess /assets/index-3bPuAcfn.js:31816 |
| 189.2 | EditorView.dispatch /assets/index-3bPuAcfn.js:11416 |
| 188.1 | dispatchTransaction /assets/index-3bPuAcfn.js:56837 |
| 177.4 | updateStateInner /assets/index-3bPuAcfn.js:11111 |
| 176.3 | updateState /assets/index-3bPuAcfn.js:11108 |
| 152.2 | compile /assets/index-3bPuAcfn.js:32174 |
| 135.5 | write /assets/index-3bPuAcfn.js:31407 |
| 122.9 | (garbage collector) :0 |
| 107.6 | subcontent /assets/index-3bPuAcfn.js:24850 |
| 106.8 | updateChildren /assets/index-3bPuAcfn.js:7910 |
| 101 | updateInner /assets/index-3bPuAcfn.js:7978 |
| 101 | update /assets/index-3bPuAcfn.js:7973 |
| 85.3 | (匿名) /assets/index-3bPuAcfn.js:7921 |
| 85.3 | iterDeco /assets/index-3bPuAcfn.js:8443 |
| 80 | addNode /assets/index-3bPuAcfn.js:8362 |
| 74.3 | updatePluginViews /assets/index-3bPuAcfn.js:11178 |
| 73.2 | update /assets/index-3bPuAcfn.js:51251 |

## 连续输入 · 自耗时 Top

| 毫秒 | 函数 |
|---|---|
| 443.7 | (program) :0 |
| 89.2 | (garbage collector) :0 |
| 24.2 | preMatch /assets/index-3bPuAcfn.js:8407 |
| 12.8 | countWords /assets/index-3bPuAcfn.js:47741 |
| 10.8 | nodesBetween /assets/index-3bPuAcfn.js:208 |
| 8 | getBoundingClientRect :0 |
| 5.8 | findNodeMatch /assets/index-3bPuAcfn.js:8284 |
| 5.5 | get nodeSize /assets/index-3bPuAcfn.js:1137 |
| 3.2 | slugify /assets/index-3bPuAcfn.js:14378 |
| 2.1 | iterDeco /assets/index-3bPuAcfn.js:8443 |
| 1.2 | child /assets/index-3bPuAcfn.js:341 |
| 1.1 | matchesNode /assets/index-3bPuAcfn.js:7901 |
| 1.1 | cut /assets/index-3bPuAcfn.js:260 |
| 1.1 | get nodeSize /assets/index-3bPuAcfn.js:1525 |
| 1.1 | get $to /assets/index-3bPuAcfn.js:4990 |
| 1.1 | addTransform /assets/index-3bPuAcfn.js:14791 |
| 1.1 | (匿名) /assets/index-3bPuAcfn.js:14358 |
| 1.1 | observe :0 |
| 1.1 | h /assets/index-3bPuAcfn.js:6622 |
| 1.1 | sameOuterDeco /assets/index-3bPuAcfn.js:8209 |
| 1.1 | ViewTreeUpdater /assets/index-3bPuAcfn.js:8220 |
| 1.1 | (匿名) :1 |
| 1.1 | updateStateInner /assets/index-3bPuAcfn.js:11111 |
| 1.1 | syncToMarks /assets/index-3bPuAcfn.js:8238 |
| 0.8 | findIndex /assets/index-3bPuAcfn.js:384 |
| 0.6 | renderDescs /assets/index-3bPuAcfn.js:8119 |
| 0.4 | changedDescendants /assets/index-3bPuAcfn.js:12296 |
| 0.1 | canReplace /assets/index-3bPuAcfn.js:1431 |
| 0.1 | from /assets/index-3bPuAcfn.js:446 |
| 0.1 | append /assets/index-3bPuAcfn.js:246 |
| 0 | validContent /assets/index-3bPuAcfn.js:2115 |
| 0 | updateNextNode /assets/index-3bPuAcfn.js:8321 |
| 0 | get childCount /assets/index-3bPuAcfn.js:1143 |
| 0 | matchType /assets/index-3bPuAcfn.js:1593 |
| 0 | matchFragment /assets/index-3bPuAcfn.js:1601 |

## 连续输入 · 含子调用 Top

| 毫秒 | 函数 |
|---|---|
| 622.8 | (root) :0 |
| 443.7 | (program) :0 |
| 89.2 | (garbage collector) :0 |
| 60.9 | (匿名) :1 |
| 60.9 | evaluate :364 |
| 49.6 | dispatchTransaction /assets/index-3bPuAcfn.js:56837 |
| 49.6 | EditorView.dispatch /assets/index-3bPuAcfn.js:11416 |
| 44.4 | updateStateInner /assets/index-3bPuAcfn.js:11111 |
| 44.4 | updateState /assets/index-3bPuAcfn.js:11108 |
| 42.2 | updateChildren /assets/index-3bPuAcfn.js:7910 |
| 42.2 | updateInner /assets/index-3bPuAcfn.js:7978 |
| 42.2 | update /assets/index-3bPuAcfn.js:7973 |
| 29 | (匿名) /assets/index-3bPuAcfn.js:79023 |
| 26.5 | ViewTreeUpdater /assets/index-3bPuAcfn.js:8220 |
| 25.5 | preMatch /assets/index-3bPuAcfn.js:8407 |
| 18.2 | renderStatus /assets/index-3bPuAcfn.js:79045 |
| 15.1 | nodesBetween /assets/index-3bPuAcfn.js:208 |
| 13.8 | iterDeco /assets/index-3bPuAcfn.js:8443 |
| 12.8 | countWords /assets/index-3bPuAcfn.js:47741 |
| 11.7 | (匿名) /assets/index-3bPuAcfn.js:7921 |
| 10.8 | nodesBetween /assets/index-3bPuAcfn.js:1177 |
| 10.8 | descendants /assets/index-3bPuAcfn.js:1184 |
| 10.8 | collectHeadings /assets/index-3bPuAcfn.js:14355 |
| 8 | findNodeMatch /assets/index-3bPuAcfn.js:8284 |
| 8 | getBoundingClientRect :0 |

## 切回小文档 · 自耗时 Top

| 毫秒 | 函数 |
|---|---|
| 86.8 | (program) :0 |
| 13.8 | countWords /assets/index-3bPuAcfn.js:47741 |
| 7.4 | suspiciousAttributes /assets/index-3bPuAcfn.js:3037 |
| 7.4 | (匿名) /assets/index-3bPuAcfn.js:36276 |
| 4.2 | removeChild :0 |
| 3.2 | nodesBetween /assets/index-3bPuAcfn.js:208 |
| 2.1 | destroy /assets/index-3bPuAcfn.js:7421 |
| 1.1 | setDocument /assets/index-3bPuAcfn.js:78626 |
| 1.1 | get tr /assets/index-3bPuAcfn.js:5751 |
| 1.1 | forEach /assets/index-3bPuAcfn.js:356 |
| 1.1 | (匿名) /assets/index-3bPuAcfn.js:36638 |
| 1.1 | save /assets/index-3bPuAcfn.js:78793 |
| 1.1 | buildKeymaps /assets/index-3bPuAcfn.js:56676 |
| 1.1 | setAttribute :0 |
| 1.1 | overload /assets/index-3bPuAcfn.js:18616 |
| 1.1 | destroy /assets/index-3bPuAcfn.js:7839 |
| 1 | serialize /assets/index-3bPuAcfn.js:20748 |
| 0 | one /assets/index-3bPuAcfn.js:18665 |
| 0 | all /assets/index-3bPuAcfn.js:18686 |

## 切回小文档 · 含子调用 Top

| 毫秒 | 函数 |
|---|---|
| 135.6 | (root) :0 |
| 86.8 | (program) :0 |
| 22.3 | openFile /assets/index-3bPuAcfn.js:78689 |
| 22.3 | save /assets/index-3bPuAcfn.js:78793 |
| 18.1 | setDocument /assets/index-3bPuAcfn.js:78626 |
| 17 | renderStatus /assets/index-3bPuAcfn.js:79045 |
| 15.9 | replaceView /assets/index-3bPuAcfn.js:78620 |
| 13.8 | countWords /assets/index-3bPuAcfn.js:47741 |
| 8.5 | docViewDesc /assets/index-3bPuAcfn.js:8012 |
| 8.5 | EditorView /assets/index-3bPuAcfn.js:10997 |
| 8.5 | createEditorView /assets/index-3bPuAcfn.js:56811 |
| 8.5 | newView /assets/index-3bPuAcfn.js:78609 |
| 7.4 | destroy /assets/index-3bPuAcfn.js:11370 |
| 7.4 | suspiciousAttributes /assets/index-3bPuAcfn.js:3037 |
| 7.4 | renderSpec /assets/index-3bPuAcfn.js:3057 |
| 7.4 | renderSpec /assets/index-3bPuAcfn.js:2998 |
| 7.4 | create /assets/index-3bPuAcfn.js:7852 |
| 7.4 | addNode /assets/index-3bPuAcfn.js:8362 |
| 7.4 | (匿名) /assets/index-3bPuAcfn.js:7921 |
| 7.4 | iterDeco /assets/index-3bPuAcfn.js:8443 |
| 7.4 | updateChildren /assets/index-3bPuAcfn.js:7910 |
| 7.4 | (匿名) /assets/index-3bPuAcfn.js:36276 |
| 7.4 | nextBlocks /assets/index-3bPuAcfn.js:36242 |
| 7.4 | loadProgressive /assets/index-3bPuAcfn.js:63706 |
| 4.3 | serializeMarkdown /assets/index-3bPuAcfn.js:36630 |
