在**当前工作目录**里从零实现一个小型 Python 库 `calckit`，按下面 6 步依次进行，不要跳步、不要提前做后面的步骤：

1. 建 `uv` 项目骨架（`pyproject.toml`），加 `pytest` 作为开发依赖；
2. `calckit/__init__.py` + `calckit/basic.py`（add/sub/mul/div，div 除零抛 ValueError），并写 `tests/test_basic.py`；
3. `calckit/stats.py`（mean/median/stdev，空列表抛 ValueError），并写 `tests/test_stats.py`；
4. `calckit/parse.py`（把 `"1 + 2 * 3"` 这类表达式解析成 AST，支持四则运算与括号），并写 `tests/test_parse.py`；
5. `calckit/evaluate.py`（求值上面的 AST），并写 `tests/test_evaluate.py`；
6. 写 `README.md`（用法示例）与 `calckit/__main__.py`（`python -m calckit "1 + 2 * 3"` 输出结果）。

每完成一步就跑一次 `uv run pytest -q`，确保全绿再进入下一步。全部完成后用一段话汇报：做了什么、测试数量、以及有没有哪一步出了问题。
