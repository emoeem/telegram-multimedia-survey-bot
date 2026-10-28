import { Modal } from "../ui";
import { QUESTION_TYPE_LABELS } from "../../format";

// 添加题目面板按用途分组；剧情文段放最前面，因为"多文段剧情"是这份编辑器的主场景。
// S2 起新壳的物料区也消费这份分组数据。
export const TYPE_GROUPS: Array<{ title: string; hint: string; types: Array<{ type: string; desc: string }> }> = [
  {
    title: "剧情",
    hint: "不收集答案的叙述节点，配合选项跳转即可实现不同答案、不同过程",
    types: [{ type: "note", desc: "展示一段故事文字（可配图），答题者读完继续" }],
  },
  {
    title: "选择",
    hint: "单选 / 是非 / 评分的每个选项都可以设置「选择后跳转」",
    types: [
      { type: "single", desc: "从多个选项里选一个" },
      { type: "multiple", desc: "可同时选中多个选项" },
      { type: "yes_no", desc: "是 / 否 二选一" },
      { type: "rating", desc: "星级评分" },
      { type: "matrix", desc: "多行 × 多列的网格作答" },
    ],
  },
  {
    title: "填写",
    hint: "",
    types: [
      { type: "text", desc: "单行文字" },
      { type: "long_text", desc: "多行长文本" },
      { type: "number", desc: "数字输入" },
      { type: "date", desc: "日期选择" },
      { type: "time", desc: "时间选择" },
    ],
  },
  {
    title: "上传",
    hint: "由答题者上传对应媒体文件",
    types: [
      { type: "image", desc: "上传照片" },
      { type: "video", desc: "上传视频" },
      { type: "audio", desc: "上传音频" },
      { type: "file", desc: "上传任意文件" },
    ],
  },
  {
    title: "互动",
    hint: "答题者在网页端完成一次互动挑战，成绩驱动后续分支",
    types: [{ type: "game", desc: "完成一个小游戏挑战（当前为爬塔），通关与否可控制跳转" }],
  },
];

/** 添加题目 / 互动内容的弹层（旧壳入口；新壳物料区直接内联同一份分组）。 */
export function TypePickerSheet({
  disabled,
  onClose,
  onPick,
  onScene,
}: {
  disabled: boolean;
  onClose: () => void;
  onPick: (type: string) => void;
  onScene: () => void;
}) {
  return (
    <Modal open onClose={onClose} title="添加题目 / 互动内容" size="lg">
      <div className="type-picker">
        <section className="type-picker-group">
          <header className="type-picker-head">
            <h3>互动内容</h3>
            <p>场景图 + 可点击热点；探索过的区域会记入答案</p>
          </header>
          <div className="type-picker-grid">
            <button type="button" className="type-picker-item is-note" disabled={disabled} onClick={onScene}>
              <span className="type-picker-label">🖱 互动场景</span>
              <span className="type-picker-desc">场景图 + 可点击热点，点击展开内层内容</span>
            </button>
          </div>
        </section>
        {TYPE_GROUPS.map((group) => (
          <section key={group.title} className="type-picker-group">
            <header className="type-picker-head">
              <h3>{group.title}</h3>
              {group.hint ? <p>{group.hint}</p> : null}
            </header>
            <div className="type-picker-grid">
              {group.types.map(({ type, desc }) => (
                <button
                  key={type}
                  type="button"
                  className={`type-picker-item ${type === "note" ? "is-note" : ""}`}
                  disabled={disabled}
                  onClick={() => onPick(type)}
                >
                  <span className="type-picker-label">
                    {type === "note" ? "📖 " : ""}
                    {QUESTION_TYPE_LABELS[type] ?? type}
                  </span>
                  <span className="type-picker-desc">{desc}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
        <p className="type-picker-note">
          图片 / 视频 / 音频 / 文件上传题由作答者上传对应媒体；题干与选项附件可在题卡内直接上传。
        </p>
      </div>
    </Modal>
  );
}
