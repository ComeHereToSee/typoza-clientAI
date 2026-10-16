# prosemirror-tables 1.8 的两个用法坑

> 分类:bug。来源:2026-10-16 表格 E2E 失败排查(`editor/src/plugins/table.ts`)。

1. **`addColumn` 在已有步骤的事务里算错位置**:它把位置再经过整个事务的映射,同一事务里先 `addRow` 再 `addColumn` 会越界(`RangeError: Position N out of range`)。修复:`resizeTable` 每加 / 删一行一列都在上一步结果的新状态上新开事务,最后把各步合成一个事务(撤销一步撤回)。
2. **`moveTableRow` / `moveTableColumn` 的 `pos` 只管找表**:取行列时仍按当前选区找表格,光标不在表里直接返回 false。修复:拖动松手时先把光标放进被拖的行 / 列。
