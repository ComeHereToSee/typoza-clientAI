// 代码块用到的 CodeMirror 6 接口。由 codeblock.ts 按需 import():CodeMirror 与语言包不进启动主包,第一个代码块接近视口或要编辑时才载入。
export { defaultKeymap, indentSelection, indentWithTab } from '@codemirror/commands'
export { LanguageDescription, bracketMatching, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language'
export { languages } from '@codemirror/language-data'
export { Compartment, EditorState } from '@codemirror/state'
export { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view'
export { classHighlighter } from '@lezer/highlight'
