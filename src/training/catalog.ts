import { LANDING_LEARNING_CONTENT } from './landing'
import { STRAIGHT_LINE_LEARNING_CONTENT } from './straightLine'
import { DIRECTION_CONTROL_LEARNING_CONTENT } from './directionControl'
import { COORDINATED_TURN_LEARNING_CONTENT } from './coordinatedTurn'
import { SQUARE_ROUTE_LEARNING_CONTENT } from './squareRoute'
import { FIGURE_EIGHT_LEARNING_CONTENT } from './figureEight'
import { WIDE_GATE_LEARNING_CONTENT } from './wideGate'
import { BASIC_RECOVERY_LEARNING_CONTENT } from './basicRecovery'
import { FULL_ROLL_LEARNING_CONTENT } from './fullRoll'
import { BACK_FLIP_LEARNING_CONTENT, FRONT_FLIP_LEARNING_CONTENT, FULL_FLIP_LEARNING_CONTENT } from './fullFlip'

export interface LessonLearningContent {
  readonly code: string
  readonly title: string
  readonly level: string
  readonly prerequisiteIds: readonly string[]
  readonly objectives: readonly string[]
  readonly steps: readonly string[]
  readonly commonMistakes: readonly string[]
}

const LEARNING_CONTENT: Readonly<Record<string, LessonLearningContent>> = {
  landing: LANDING_LEARNING_CONTENT,
  'straight-line': STRAIGHT_LINE_LEARNING_CONTENT,
  'direction-control': DIRECTION_CONTROL_LEARNING_CONTENT,
  takeoff: {
    code: 'L01',
    title: '起飛與定點懸停',
    level: '入門',
    prerequisiteIds: ['intro'],
    objectives: ['從起飛墊受控離地，再減少升降與水平漂移。', '在墊上方 2 公尺附近定點懸停，連續穩住 1.5 秒。'],
    steps: [
      '先完成 L00 操作認識，確認油門與姿態控制方向。',
      '重設課程後保持低油門；倒數結束、確認起飛區後再解鎖。',
      '緩慢加油門垂直離地，避免同時大幅推動方向軸。',
      '接近目標高度時提早減少上升速度，以小幅修正維持水平位置。',
      '先減少水平漂移，再用小量油門修正高度，讓速度與姿態穩定。',
      '在起飛墊上方定點懸停，連續穩住 1.5 秒後，才算完成起飛與懸停。',
    ],
    commonMistakes: [
      '把油門推得太快，接近目標才急收，造成高度來回震盪。',
      '用大幅傾斜修正位置，忽略了側移速度還未消失。',
      '只碰到目標高度或短暫穿過目標區便停止修正；需要定點懸停並連續穩住。',
    ],
  },
  // Historical standalone hover metadata; the active course is now L01 takeoff.
  hover: {
    code: 'L02',
    title: '定點懸停',
    level: '入門',
    prerequisiteIds: ['takeoff'],
    objectives: ['進入綠色懸停區。', '讓高度、水平漂移、速度與傾角同時穩定。'],
    steps: [
      '從起飛墊起飛，緩慢接近綠色懸停區。',
      '先觀察漂移方向，用小幅傾斜降低側移速度。',
      '回到近乎水平，以小油門修正維持高度。',
      '連續維持懸停，不把短暫穿過目標當作完成。',
    ],
    commonMistakes: [
      '只看位置、不看速度，導致修正後仍持續滑出目標區。',
      '一次同時做太多軸的大幅修正，難以辨認漂移原因。',
      '離開目標區後急著追回，反而越修越大。',
    ],
  },
  'coordinated-turn': COORDINATED_TURN_LEARNING_CONTENT,
  'square-route': SQUARE_ROUTE_LEARNING_CONTENT,
  'figure-eight': FIGURE_EIGHT_LEARNING_CONTENT,
  'wide-gate': WIDE_GATE_LEARNING_CONTENT,
  'basic-recovery': BASIC_RECOVERY_LEARNING_CONTENT,
  'full-roll': FULL_ROLL_LEARNING_CONTENT,
  'full-flip': FULL_FLIP_LEARNING_CONTENT,
  'front-flip': FRONT_FLIP_LEARNING_CONTENT,
  'back-flip': BACK_FLIP_LEARNING_CONTENT,
  'split-s': {
    code: 'L14',
    title: '翻轉下降',
    level: '特技',
    prerequisiteIds: ['coordinated-turn'],
    objectives: ['完成實際倒飛與下降半迴圈。', '反轉航向後恢復正飛，保留足夠高度。'],
    steps: [
      '課程會從較高位置開始，先確認姿態與參考方向。',
      '完整滾轉至倒飛，觀察機體確實翻面。',
      '以俯仰帶入下降半迴圈，使航向逐漸反轉。',
      '在安全高度內恢復正飛並降低過大速度。',
    ],
    commonMistakes: [
      '尚未倒飛就偏航迴轉；水平 U 形轉彎不能代替 Split-S。',
      '下降前高度不足，恢復時越過安全高度下限。',
      '急拉回正造成過大速度或超出可恢復範圍。',
    ],
  },
  orbit: {
    code: 'L15',
    title: '正刷鍋',
    level: '特技',
    prerequisiteIds: ['coordinated-turn'],
    objectives: ['繞塔完成同方向的一整圈實際軌跡。', '維持半徑、高度、速度與鏡頭朝向。'],
    steps: [
      '先到塔旁約 10 公尺半徑的參考高度，建立側向移動。',
      '選定一個方向，用小幅姿態與偏航修正維持環繞。',
      '觀察塔在畫面中的位置，避免半徑逐漸縮小或變大。',
      '持續同方向完成一整圈，並讓最後一段速度與高度穩定。',
    ],
    commonMistakes: [
      '原地轉機頭而沒有繞塔移動，無法累積環繞進度。',
      '反覆來回走小段弧線，沒有完成同方向的一圈。',
      '只顧鏡頭對準塔，忽略半徑、高度或速度持續偏離。',
    ],
  },
}

export function lessonLearningContent(lessonId: string): LessonLearningContent | null {
  return LEARNING_CONTENT[lessonId] ?? null
}
