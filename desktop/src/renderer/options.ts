// Model aliases are resolved by Claude Code on the VPS to the newest version; never hardcode versions here.
export const MODELS = [
  { id: '', label: '默认', desc: '跟随账号默认' },
  { id: 'opus', label: 'Opus', desc: '最强，适合复杂任务' },
  { id: 'sonnet', label: 'Sonnet', desc: '快而稳，日常编码' },
  { id: 'haiku', label: 'Haiku', desc: '最快最省' },
  { id: 'fable', label: 'Fable', desc: '可能消耗额外额度' },
];
export const EFFORTS = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '超高' },
  { id: 'max', label: '最高' },
];
export const PERMS = [
  { id: 'default', label: '每次询问', desc: '编辑文件和运行命令前问你' },
  { id: 'acceptEdits', label: '自动接受编辑', desc: '改文件不问，运行命令仍会问' },
  { id: 'plan', label: '计划模式', desc: '只读，先给出方案' },
  { id: 'auto', label: '自动', desc: '由 Claude Code 判断风险' },
  { id: 'bypassPermissions', label: '全部允许', desc: '不再询问，谨慎使用' },
];

/** "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5" */
export function prettyModel(id?: string | null): string | null {
  if (!id) return null;
  const m = id.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/i);
  if (!m) return id;
  const fam = m[1][0].toUpperCase() + m[1].slice(1);
  return `${fam} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}
export const modelLabel = (alias: string) => MODELS.find((m) => m.id === alias)?.label || alias;
export const effortLabel = (id: string) => EFFORTS.find((e) => e.id === id)?.label || id;
export const permLabel = (id: string) => PERMS.find((p) => p.id === id)?.label || id;
