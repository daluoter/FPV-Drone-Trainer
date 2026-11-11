/** Display-only translations. Domain diagnostics and saved evidence stay intact. */
const exactMessages: Readonly<Record<string, string>> = {
  'Select a connected controller.': '請選擇已連接的控制器。',
  'The selected controller is disconnected.': '所選控制器已中斷連線。',
  'The selected device is disconnected.': '所選設備已中斷連線。',
  'Complete controller calibration.': '請先完成遙控器校正。',
  'The saved profile does not match this device; recalibrate before flight.': '儲存的校正設定與此設備不符；請重新校正後再飛行。',
  'Verify each channel direction before flight.': '飛行前請確認每個通道的方向。',
  'Pass the hands-off neutral stability test before flight.': '飛行前請先通過不碰搖桿的回中穩定性測試。',
  'Run a fresh timed neutral test for this controller connection before flight.': '本次控制器連線需要重新完成計時回中測試，才能飛行。',
  'No processed controller sample is available.': '尚未取得處理後的控制器訊號。',
  'The latest controller sample contains invalid input.': '最新的控制器訊號含有無效輸入。',
  'Center samples are empty, inconsistent, or contain a non-finite value.': '中心取樣沒有資料、格式不一致，或含有無效數值。',
  'Movement samples do not match the centered baseline or contain a non-finite value.': '移動取樣與中心基準不符，或含有無效數值。',
  'Endpoint samples are empty or contain a non-finite value.': '行程端點取樣沒有資料，或含有無效數值。',
  'The recorded endpoint range is empty.': '尚未錄到有效的行程範圍。',
  'Both sides of the centered stick must reach a distinct endpoint.': '請讓搖桿從中心向兩側移動到明確的行程端點。',
  'Neutral output stayed within the configured stability limits.': '回中輸出全程維持在設定的穩定範圍內。',
  'Neutral stability report is missing.': '缺少回中穩定性報告。',
  'Neutral sample count must be a finite non-negative integer.': '回中取樣數必須是有效的非負整數。',
  'Neutral capture duration must be a finite non-negative number.': '回中取樣時間必須是有效的非負數值。',
  'capture duration is not finite': '取樣時間含有無效數值',
  'Profile schema version is unsupported.': '不支援此校正設定的資料版本。',
  'Profile device ID is empty.': '校正設定缺少設備識別碼。',
  'Profile axis count is invalid.': '校正設定的軸數無效。',
  'Profile button count is invalid.': '校正設定的按鈕數無效。',
  'Throttle mode is unsupported.': '不支援此油門模式。',
  'Calibration timestamp is missing.': '缺少校正時間。',
  'Direction verification timestamp is malformed.': '方向確認時間的格式無效。',
  'Neutral verification timestamp is malformed.': '回中確認時間的格式無效。',
  'Neutral verification session is malformed.': '回中確認的連線紀錄格式無效。',
  'Neutral verification session is empty.': '回中確認缺少連線紀錄。',
  'A neutral verification timestamp requires stable neutral evidence.': '回中確認時間必須對應通過的穩定性證據。',
  'A neutral verification timestamp requires a neutral report.': '回中確認時間必須對應一份回中測試報告。',
  'Profile device ID does not match the selected device.': '校正設定的設備識別碼與所選設備不符。',
  'Profile mapping does not match the selected device.': '校正設定的映射方式與所選設備不符。',
  'Profile axis count does not match the selected device.': '校正設定的軸數與所選設備不符。',
  'Profile button count does not match the selected device.': '校正設定的按鈕數與所選設備不符。',
  'Browser storage is unavailable.': '無法使用瀏覽器儲存空間。',
  'Browser storage could not be read.': '無法讀取瀏覽器儲存的資料。',
  'Browser storage rejected the controller profile.': '瀏覽器無法儲存校正設定。',
  'Browser storage rejected the tuning settings.': '瀏覽器無法儲存飛行參數。',
  'Browser storage rejected the tuning reset.': '瀏覽器無法儲存恢復預設的設定。',
  'Saved tuning settings were rejected.': '儲存的飛行參數未通過檢查。',
  'Saved tuning settings were corrupt and were rejected.': '儲存的飛行參數已損壞，無法載入。',
  'Tuning changes are disabled while a lesson is counting down or active. Reset or end the lesson first.': '課程倒數或練習中無法調整參數，請先重設或結束課程。',
  'Tuning settings are missing.': '缺少飛行參數設定。',
  'Camera tuning configuration is missing.': '缺少鏡頭參數設定。',
  'PID configuration is missing.': '缺少 PID 設定。',
  'Rate PID configuration is missing.': '缺少角速度 PID 設定。',
  'Actual Rates configuration is missing.': '缺少角速度曲線（Actual Rates）設定。',
  'Rates configuration must contain an axes object.': '角速度曲線設定必須包含各軸資料。',
  'Rate limits configuration is missing.': '缺少角速度限制設定。',
  'Flight-controller configuration is missing.': '缺少飛控設定。',
  'configuration must contain roll, pitch and yaw axes.': '設定必須包含橫滾、俯仰與偏航三軸。',
  'Drone configuration is missing.': '缺少機體設定。',
  'Drone configuration name is empty.': '機體設定缺少名稱。',
  'Diagonal inertia must contain finite positive values.': '各軸轉動慣量必須是有效的正數。',
  'Quad configuration must contain exactly four motors.': '四軸機體設定必須包含四顆馬達。',
  'Ground configuration is missing.': '缺少地面設定。',
  'Safety configuration is missing.': '缺少安全限制設定。',
  'Mixer configuration is missing.': '缺少馬達混控設定。',
  'Derivative-on-measurement option must be boolean.': '依量測值計算微分的選項必須為開啟或關閉。',
}

const channels: Readonly<Record<string, string>> = { roll: '橫滾', pitch: '俯仰', yaw: '偏航', throttle: '油門' }
const fields: Readonly<Record<string, string>> = {
  'Center rate': '中心靈敏度', 'Maximum rate': '最大角速度', Expo: '曲線彎曲程度（Expo）',
  Mass: '機體質量', 'Arm length': '機臂長度', Gravity: '重力加速度',
  'Linear drag coefficient': '平移阻力係數', 'Angular drag coefficient': '旋轉阻力係數',
  'Ground height': '地面高度', 'Ground restitution': '地面碰撞恢復係數',
  'Ground tangential velocity retention': '接地時的水平速度保留比例',
  'Maximum linear speed': '最大平移速度', 'Maximum angular speed': '最大旋轉速度',
  'Maximum distance': '最大距離', 'Spawn position': '起始位置',
  'Integral limit': '積分上限', 'Output limit': '扭矩輸出上限',
  'Derivative filter time constant': '微分濾波時間常數',
  'FPV field of view': 'FPV 視野角度', kp: '比例增益 P', ki: '積分增益 I', kd: '微分增益 D',
}

/** Only known field templates are interpreted; user/device identifiers remain literal. */
function fieldLabel(label: string): string {
  if (Object.hasOwn(fields, label)) return fields[label]
  let match = /^(roll|pitch|yaw) rate limit$/u.exec(label)
  if (match) return `${channels[match[1]]}角速度限制`
  match = /^PID (roll|pitch|yaw) (kp|ki|kd)$/u.exec(label)
  if (match) return `${channels[match[1]]} ${fields[match[2]]}`
  match = /^(Linear|Angular) drag ([xyz])$/u.exec(label)
  if (match) return `${match[1] === 'Linear' ? '平移' : '旋轉'}阻力係數 ${match[2].toUpperCase()}`
  match = /^Motor (\d+)(?: (maximum thrust|response time constant))?$/u.exec(label)
  if (match) return `馬達 ${match[1]}${match[2] === 'maximum thrust' ? '最大推力' : match[2] === 'response time constant' ? '反應時間常數' : ''}`
  match = /^(.+) (position|maximum thrust|response time constant|yaw reaction coefficient)$/u.exec(label)
  if (match) {
    const attributes: Readonly<Record<string, string>> = {
      position: '位置', 'maximum thrust': '最大推力', 'response time constant': '反應時間常數', 'yaw reaction coefficient': '偏航反作用係數',
    }
    return `${fieldLabel(match[1])} 的${attributes[match[2]]}`
  }
  return label
}

const channelIssues: Readonly<Record<string, string>> = {
  'calibration is missing.': '缺少校正資料。',
  'axis index is outside the device range.': '所指定的軸超出設備提供的範圍。',
  'reuses an axis already assigned to another channel.': '與其他通道重複使用同一個軸。',
  'contains a non-finite endpoint.': '行程端點含有無效數值。',
  'endpoint order is invalid.': '行程端點的最小值與最大值順序無效。',
  'center is not inside its calibrated endpoints.': '中心值不在校正的行程範圍內。',
  'deadband is outside the safe configurable range.': '搖桿死區超出允許範圍。',
  'must be neutral before arming.': '必須先回中，才能解鎖。',
  'maximum neutral output must be finite and non-negative.': '回中最大輸出必須是有效的非負數值。',
  'neutral mean must be finite.': '回中平均值必須是有效數值。',
  'neutral standard deviation must be finite and non-negative.': '回中標準差必須是有效的非負數值。',
  'neutral mean exceeds its maximum absolute output.': '回中平均值超過最大輸出絕對值。',
  'neutral deviation exceeds its maximum absolute output.': '回中標準差超過最大輸出絕對值。',
  'contains a non-finite processed value': '處理後的輸入含有無效數值',
  'mixer weight is invalid.': '馬達混控權重無效。',
}

type MessageRule = readonly [RegExp, (...groups: string[]) => string]
const rules: readonly MessageRule[] = [
  [/^No axis moved far enough \(largest excursion (.+); need (.+)\)\.$/u, (actual, needed) => `搖桿移動幅度不足（最大偏移 ${actual}；需要 ${needed}）。`],
  [/^Multiple axes moved together \((\d+) and (\d+)\); move only the requested control\.$/u, (first, second) => `軸 ${first} 與軸 ${second} 同時移動；請只操作目前要求的搖桿。`],
  [/^Axis (\d+) moved significantly and is distinct from the other axes\.$/u, (axis) => `已辨識軸 ${axis}；其移動幅度明顯且可與其他軸區分。`],
  [/^Throttle range is too small; move from minimum to maximum \(need (.+)\)\.$/u, (needed) => `油門行程不足；請從最低推至最高（行程差需要 ${needed}）。`],
  [/^Throttle must be at or below (.+) before arming\.$/u, (limit) => `油門必須降至 ${limit} 以下，才能解鎖。`],
  [/^(roll|pitch|yaw|throttle) (.+)$/iu, (channel, issue) => Object.hasOwn(channelIssues, issue) ? `${channels[channel.toLowerCase()]}${channelIssues[issue]}` : ''],
  [/^(roll|pitch|yaw) reached (.+) \(limit (.+)\)$/u, (channel, actual, limit) => `${channels[channel]}回中輸出達 ${actual}（上限 ${limit}）`],
  [/^(roll|pitch|yaw) jitter is (.+) \(limit (.+)\)$/u, (channel, actual, limit) => `${channels[channel]}回中抖動標準差為 ${actual}（上限 ${limit}）`],
  [/^only (.+) samples; need (.+)$/u, (actual, needed) => `只有 ${actual} 個樣本；需要 ${needed} 個`],
  [/^only (.+) ms; need (.+) ms$/u, (actual, needed) => `只取樣 ${actual} ms；需要 ${needed} ms`],
  [/^(?:Neutral threshold|threshold) must be between (.+) and (.+)\.?$/u, (min, max) => `回中門檻必須介於 ${min} 至 ${max.replace(/\.$/u, '')}`],
  [/^standard deviation limit must be between (.+) and (.+)$/u, (min, max) => `標準差上限必須介於 ${min} 至 ${max}`],
  [/^sample count policy must be at least (.+)$/u, (needed) => `最低取樣數不得少於 ${needed}`],
  [/^duration policy must be at least (.+) ms$/u, (needed) => `最低取樣時間不得少於 ${needed} ms`],
  [/^Neutral stable status is inconsistent with its capture window and metrics \(expected (true|false)\)\.$/u, (expected) => `回中穩定狀態與取樣時間及數值不符（依資料應為${expected === 'true' ? '通過' : '未通過'}）。`],
  [/^Tuning settings schema version (.+) is unsupported\.$/u, (version) => `不支援飛行參數資料版本 ${version}。`],
  [/^FPV mount angle must be one of (.+) degrees\.$/u, (angles) => `FPV 鏡頭安裝仰角必須選擇 ${angles} 度其中之一。`],
  [/^PID (roll|pitch|yaw) configuration is missing\.$/u, (channel) => `缺少${channels[channel]} PID 設定。`],
  [/^(.+) must be finite and in \[(.+), (.+)\]\.$/u, (label, min, max) => `${fieldLabel(label)}必須是 ${min} 至 ${max} 之間的有效數值。`],
  [/^(.+) must be finite and non-negative\.$/u, (label) => `${fieldLabel(label)}必須是有效的非負數值。`],
  [/^(.+) must be finite and greater than zero\.$/u, (label) => `${fieldLabel(label)}必須是大於零的有效數值。`],
  [/^(.+) must be greater than zero\.$/u, (label) => `${fieldLabel(label)}必須大於零。`],
  [/^(.+) must contain finite values\.$/u, (label) => `${fieldLabel(label)}必須包含有效數值。`],
  [/^(.+) cannot contain negative values\.$/u, (label) => `${fieldLabel(label)}不可包含負數。`],
  [/^Motor (\d+) configuration is missing\.$/u, (index) => `缺少馬達 ${index} 設定。`],
  [/^Motor ID (.+) is duplicated\.$/u, (id) => `馬達識別碼 ${id} 重複。`],
  [/^(.+) ID is invalid\.$/u, (id) => `${fieldLabel(id)} 的識別碼無效。`],
  [/^(.+) position must contain finite values\.$/u, (id) => `${fieldLabel(id)} 的位置必須包含有效數值。`],
  [/^(.+) maximum thrust must be greater than zero\.$/u, (id) => `${fieldLabel(id)} 的最大推力必須大於零。`],
  [/^(.+) response time constant must be greater than zero\.$/u, (id) => `${fieldLabel(id)} 的反應時間常數必須大於零。`],
  [/^(.+) yaw reaction coefficient must be non-negative\.$/u, (id) => `${fieldLabel(id)} 的偏航反作用係數不可為負數。`],
  [/^(.+) spin direction is invalid\.$/u, (id) => `${fieldLabel(id)} 的旋轉方向無效。`],
]

const prefixes: Readonly<Record<string, string>> = {
  controller: '飛控', drone: '機體', camera: '鏡頭', rates: '角速度曲線',
  'rate limits': '角速度限制', pid: 'PID', roll: '橫滾', pitch: '俯仰', yaw: '偏航',
  'pid roll': '橫滾 PID', 'pid pitch': '俯仰 PID', 'pid yaw': '偏航 PID',
}

/** Translate known diagnostics at the UI boundary, including legacy saved reasons. */
export function localizedSetupMessage(message: string): string {
  if (Object.hasOwn(exactMessages, message)) return exactMessages[message]
  const prefix = /^(controller|drone|camera|rates|rate limits|pid(?: roll| pitch| yaw)?|roll|pitch|yaw): (.+)$/u.exec(message)
  if (prefix) return `${prefixes[prefix[1]]}：${localizedSetupMessage(prefix[2])}`
  // A failed neutral report joins several reasons. Keep each reason's internal
  // "; need ..." intact, including reports saved before the UI was translated.
  const reasons = message.split(/; (?=(?:threshold|standard deviation|sample count|duration policy|capture duration|only|roll|pitch|yaw)\b)/u)
  if (reasons.length > 1) return reasons.map(localizedSetupMessage).join('；')
  for (const [pattern, translate] of rules) {
    const match = pattern.exec(message)
    if (match) {
      const translated = translate(...match.slice(1))
      if (translated) return translated
    }
  }
  // Never invent a cause or discard an unfamiliar diagnostic or device ID.
  return message
}
