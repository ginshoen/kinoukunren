/**
 * 銀松苑 機能訓練記録アプリ — GAS サーバー
 * データベース: Google スプレッドシート
 *
 * 初回セットアップ: エディタで setup() を一度実行
 *   - コンテナバインド(スプレッドシートの拡張機能から作成)なら、そのシートに構築
 *   - スタンドアロンなら新規スプレッドシート「機能訓練記録DB」を作成して ID を保存
 */

var SHEETS = {
  staff: '職員マスタ',
  users: '利用者マスタ',
  exercises: '種目マスタ',
  checkins: 'チェックイン',
  vitals: 'バイタル',
  records: '訓練記録',
  cognitive: '脳トレ記録',
  assessments: '評価記録',
  voids: '取消記録',
};

var HEADERS = {
  staff: ['ID', '氏名', 'ふりがな', '職種', '権限', 'PINハッシュ', '有効', 'PINソルト', 'セッション世代'],
  users: ['ID', '氏名', '年齢', '介護度', '利用曜日', '予定種目', 'QRコード', 'ふりがな', '個人目標', '既往歴', '運動禁止事項'],
  exercises: ['ID', '種目名', '短縮名', '選択肢ラベル', '選択肢', 'QRコード'],
  checkins: ['ID', '日付', '来苑時刻', '利用者ID', '帰苑時刻', '送迎区分', '記録者'],
  vitals: ['ID', '日付', '時刻', '利用者ID', '収縮期', '拡張期', '脈拍', '体温', 'SpO2', '体重', 'アラートフラグ', 'アラート内容', '体調・特記事項', '記録者'],
  records: ['ID', '日付', '時刻', '利用者ID', '種目ID', '実施量', '負荷', '所見', '記録者'],
  cognitive: ['ID', '日付', '時刻', '利用者ID', '実施内容', '結果・所見', '記録者'],
  assessments: ['ID', '日付', '利用者ID', '評価種別', '結果', '詳細', '記録者'],
  voids: ['対象ID', '種別', '取消日時', '取消者'],
};

// 旧版から名称だけ変更した列。順序が一致する場合に限り安全に移行する。
var HEADER_ALIASES = {
  checkins: { 2: ['時刻', '来苑時刻'] },
};

// 1回のAPI実行中に同じスプレッドシート・シート行を何度も読み直さない。
var REQUEST_SS_ = null;
var REQUEST_ROWS_ = {};
var REQUEST_VOIDED_ = null;
function resetRequestCache_() {
  REQUEST_SS_ = null;
  REQUEST_ROWS_ = {};
  REQUEST_VOIDED_ = null;
}
function invalidateRequestRows_(key) {
  delete REQUEST_ROWS_[key];
  if (key === 'voids') REQUEST_VOIDED_ = null;
}

// ---------------------------------------------------------------- Web アプリ

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('銀松苑 機能訓練記録')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * JSON API(ホスティング版フロントエンド用)。
 * iPhone/iPad は GAS の iframe 内でライブカメラを使えないため、
 * フロントエンドを外部の HTTPS サイトに置き、この doPost を fetch で呼ぶ。
 * リクエスト: {fn: API関数名, args: 引数配列, token: 任意の共有トークン}
 *
 * セキュリティ: この API を使うにはウェブアプリを「全員(匿名)」でデプロイする
 * 必要がある。スクリプトプロパティ API_TOKEN を設定すると、一致するトークンを
 * 持つリクエストのみ受け付ける(フロント側の GAS_API_TOKEN に同じ値を設定)。
 */
var API_REGISTRY = {
  // ログイン前に呼べるのはこの3つだけ
  apiPairDevice: { fn: apiPairDevice_, auth: 'none' },
  apiGetStaffList: { fn: apiGetStaffList_, auth: 'none' },
  apiLogin: { fn: apiLogin_, auth: 'none' },

  // 現場職員(staff)も使える: 受付・記録・閲覧
  apiGetSession: { fn: apiGetSession_, auth: 'staff' },
  apiGetBootstrap: { fn: apiGetBootstrap_, auth: 'staff' },
  apiGetTodayCheckins: { fn: apiGetTodayCheckins_, auth: 'staff' },
  apiCheckin: { fn: apiCheckin_, auth: 'staff' },
  apiCheckout: { fn: apiCheckout_, auth: 'staff' },
  apiRefreshToday: { fn: apiRefreshToday_, auth: 'staff' },
  apiVoidRecord: { fn: apiVoidRecord_, auth: 'staff' },
  apiGetVitalContext: { fn: apiGetVitalContext_, auth: 'staff' },
  apiSaveVitals: { fn: apiSaveVitals_, auth: 'staff' },
  apiSaveExercise: { fn: apiSaveExercise_, auth: 'staff' },
  apiSaveCognitive: { fn: apiSaveCognitive_, auth: 'staff' },
  apiSaveAssessment: { fn: apiSaveAssessment_, auth: 'staff' },
  apiGetTodayExercises: { fn: apiGetTodayExercises_, auth: 'staff' },
  apiGetTodayAlerts: { fn: apiGetTodayAlerts_, auth: 'staff' },
  apiGetUserDetail: { fn: apiGetUserDetail_, auth: 'staff' },
  apiGetTodayRecords: { fn: apiGetTodayRecords_, auth: 'staff' },
  apiGetUserResults: { fn: apiGetUserResults_, auth: 'staff' },

  // 管理者(admin)のみ: マスタ編集・帳票
  apiAdminSaveUser: { fn: apiAdminSaveUser_, auth: 'admin' },
  apiAdminDeleteUser: { fn: apiAdminDeleteUser_, auth: 'admin' },
  apiAdminGetStaff: { fn: apiAdminGetStaff_, auth: 'admin' },
  apiAdminSaveStaff: { fn: apiAdminSaveStaff_, auth: 'admin' },
  apiAdminDeleteStaff: { fn: apiAdminDeleteStaff_, auth: 'admin' },
  apiGetMonthly: { fn: apiGetMonthly_, auth: 'admin' },
  apiGetCommunicationBook: { fn: apiGetCommunicationBook_, auth: 'admin' },
  apiVerifyAdmin: { fn: apiVerifyAdmin_, auth: 'admin' },
};

/**
 * APIの実行本体。権限は必ずここ(サーバー側)で判定する。
 * 画面側のメニュー出し分けは利便性のためであり、防御はこの関数が担う。
 */
function dispatch_(fnName, args, session) {
  var entry = API_REGISTRY[String(fnName)];
  if (!entry) throw new Error('不明なAPI: ' + fnName);
  CURRENT_STAFF_ = null;
  if (entry.auth !== 'none') {
    var staff = verifySession_(session);
    if (entry.auth === 'admin' && staff.role !== 'admin') {
      throw new Error('この操作は管理者のみ実行できます');
    }
    CURRENT_STAFF_ = staff;
  }
  return entry.fn.apply(null, args || []);
}

/** GAS(HtmlService)版クライアントからの唯一の入口 */
function apiCall(fnName, args, session) {
  resetRequestCache_();
  ensureSchema_();
  return dispatch_(fnName, args, session);
}

function doPost(e) {
  var result;
  try {
    resetRequestCache_();
    var body = JSON.parse(e.postData.contents);
    var token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
    var requestedFn = String(body.fn || '');
    // 新しい端末は管理者PINで一度だけペアリングできる。通常APIは共有トークン必須。
    if (token && body.token !== token && requestedFn !== 'apiPairDevice') throw new Error('認証エラー');
    ensureSchema_();
    result = { ok: true, data: dispatch_(requestedFn, body.args, body.session) };
  } catch (err) {
    result = { ok: false, error: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- ユーティリティ

function getSs_() {
  if (REQUEST_SS_) return REQUEST_SS_;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    REQUEST_SS_ = SpreadsheetApp.openById(id);
    return REQUEST_SS_;
  }
  var active = SpreadsheetApp.getActive();
  if (active) {
    REQUEST_SS_ = active;
    return REQUEST_SS_;
  }
  throw new Error('データベースが未作成です。エディタで setup() を実行してください。');
}

function sheet_(key) {
  var sh = getSs_().getSheetByName(SHEETS[key]);
  if (!sh) throw new Error('シート「' + SHEETS[key] + '」がありません。setup() を実行してください。');
  return sh;
}

/**
 * 新しい記録項目を既存データベースへ安全に追加する。
 * 既存列は同じ順序のまま末尾へ拡張するため、過去データは失われない。
 */
function ensureSchema_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SCHEMA_VERSION') === '5') return;
  var cache = CacheService.getScriptCache();
  if (cache.get('schema-v5')) {
    props.setProperty('SCHEMA_VERSION', '5');
    return;
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = getSs_();
    Object.keys(SHEETS).forEach(function (key) {
      var sh = ss.getSheetByName(SHEETS[key]) || ss.insertSheet(SHEETS[key]);
      var lastCol = sh.getLastColumn();
      if (lastCol > 0 && sh.getLastRow() > 0) {
        var current = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
        for (var i = 0; i < current.length; i++) {
          var actual = String(current[i] || '').trim();
          if (!actual) continue;
          var expected = HEADERS[key][i];
          var aliases = HEADER_ALIASES[key] && HEADER_ALIASES[key][i];
          if (!expected || (actual !== expected && (!aliases || aliases.indexOf(actual) < 0))) {
            throw new Error('シート「' + SHEETS[key] + '」の' + (i + 1) + '列目が想定外です。自動変更を中止しました。');
          }
        }
      }
      sh.getRange(1, 1, Math.max(2, sh.getLastRow()), HEADERS[key].length).setNumberFormat('@');
      sh.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]])
        .setFontWeight('bold').setBackground('#E3F1E1');
      sh.setFrozenRows(1);
    });
    props.setProperty('SCHEMA_VERSION', '5');
    cache.put('schema-v5', '1', 21600);
  } finally {
    lock.releaseLock();
  }
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function nowTime_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H:mm');
}

function dateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function validDateStr_(value) {
  var text = dateStr_(value);
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) throw new Error('日付の形式が正しくありません。');
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    throw new Error('存在しない日付です。');
  }
  return text;
}

function timeStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'H:mm');
  return String(v);
}

function newId_() {
  return Utilities.getUuid();
}

function splitCsv_(v) {
  return String(v || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(String);
}

/** ヘッダー行を除く全行を取得(空行=1列目が空の行は除外) */
function rows_(key) {
  if (REQUEST_ROWS_[key]) return REQUEST_ROWS_[key];
  var sh = sheet_(key);
  var last = sh.getLastRow();
  if (last < 2) {
    REQUEST_ROWS_[key] = [];
    return REQUEST_ROWS_[key];
  }
  // マスタ編集ミス(列の挿入・並べ替え)を早期検知する
  var head = sh.getRange(1, 1, 1, HEADERS[key].length).getValues()[0];
  for (var i = 0; i < HEADERS[key].length; i++) {
    if (String(head[i]) !== HEADERS[key][i]) {
      throw new Error('シート「' + SHEETS[key] + '」の列構成が変更されています(' +
        (i + 1) + '列目が「' + head[i] + '」)。列は並べ替えず、ヘッダーを元に戻してください。');
    }
  }
  REQUEST_ROWS_[key] = sh.getRange(2, 1, last - 1, HEADERS[key].length).getValues()
    .filter(function (r) { return String(r[0]) !== ''; });
  return REQUEST_ROWS_[key];
}

/**
 * 1行追記。appendRow はセル値を数式・日付として解釈するため、
 * 書式'@'を明示指定した setValues で文字列のまま書き込む(1000行超対策)。
 */
function appendRow_(key, row) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    appendRowNoLock_(key, row);
  } finally {
    lock.releaseLock();
  }
}

function appendRowNoLock_(key, row) {
  var sh = sheet_(key);
  sh.getRange(sh.getLastRow() + 1, 1, 1, row.length)
    .setNumberFormat('@')
    .setValues([row.map(String)]);
  invalidateRequestRows_(key);
  if (key === 'users' || key === 'exercises') {
    CacheService.getScriptCache().remove('master-v4-' + key);
  }
}

// ---------------------------------------------------------------- 変換

function toUser_(r) {
  return {
    id: String(r[0]), name: String(r[1]), age: Number(r[2]), careLevel: String(r[3]),
    scheduleLabel: String(r[4]), plan: splitCsv_(r[5]), qrCode: String(r[6]),
    kana: String(r[7] || ''), goal: String(r[8] || ''),
    medicalHistory: String(r[9] || ''), precautions: String(r[10] || ''),
  };
}

function toExercise_(r) {
  return {
    id: String(r[0]), name: String(r[1]), shortName: String(r[2]),
    amountLabel: String(r[3]), amountOptions: splitCsv_(r[4]), qrCode: String(r[5]),
  };
}

function toCheckin_(r) {
  return {
    id: String(r[0]), date: dateStr_(r[1]), time: timeStr_(r[2]), userId: String(r[3]),
    checkoutTime: String(r[4] || ''), transport: String(r[5] || ''),
  };
}

function numOrNull_(v) {
  var s = String(v);
  return s === '' ? null : Number(s);
}

function toVital_(r) {
  return {
    id: String(r[0]), date: dateStr_(r[1]), time: timeStr_(r[2]), userId: String(r[3]),
    systolic: Number(r[4]), diastolic: Number(r[5]), pulse: Number(r[6]),
    temp: Number(r[7]), spo2: numOrNull_(r[8]), weight: numOrNull_(r[9]),
    flagged: String(r[10]) === 'true', alerts: String(r[11] || '') ? String(r[11]).split(' / ') : [],
    conditionNote: String(r[12] || ''),
  };
}

function toRecord_(r) {
  return {
    id: String(r[0]), date: dateStr_(r[1]), time: timeStr_(r[2]), userId: String(r[3]),
    exerciseId: String(r[4]), amount: String(r[5]), load: String(r[6]), note: String(r[7] || ''),
  };
}

function toCognitive_(r) {
  return {
    id: String(r[0]), date: dateStr_(r[1]), time: timeStr_(r[2]), userId: String(r[3]),
    activity: String(r[4] || ''), note: String(r[5] || ''),
  };
}

function toAssessment_(r) {
  return {
    id: String(r[0]), date: dateStr_(r[1]), userId: String(r[2]), type: String(r[3]),
    result: String(r[4] || ''), detail: String(r[5] || ''),
  };
}

function cachedMaster_(key, converter) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'master-v4-' + key;
  var saved = cache.get(cacheKey);
  if (saved) {
    try { return JSON.parse(saved); } catch (e) {}
  }
  var data = rows_(key).map(converter);
  var json = JSON.stringify(data);
  if (json.length < 90000) cache.put(cacheKey, json, 300);
  return data;
}

function allUsers_() { return cachedMaster_('users', toUser_); }
function allExercises_() { return cachedMaster_('exercises', toExercise_); }

/** 取り消し済み記録のIDセット */
function voidedIds_() {
  if (REQUEST_VOIDED_) return REQUEST_VOIDED_;
  var set = {};
  rows_('voids').forEach(function (r) { set[String(r[0])] = true; });
  REQUEST_VOIDED_ = set;
  return REQUEST_VOIDED_;
}

function notVoided_(list) {
  var voided = voidedIds_();
  return list.filter(function (x) { return !voided[x.id]; });
}

function allCheckins_() { return notVoided_(rows_('checkins').map(toCheckin_)); }
function allVitals_() { return notVoided_(rows_('vitals').map(toVital_)); }
function allRecords_() { return notVoided_(rows_('records').map(toRecord_)); }
function allCognitive_() { return notVoided_(rows_('cognitive').map(toCognitive_)); }
function allAssessments_() { return notVoided_(rows_('assessments').map(toAssessment_)); }

/** "9:05" → "09:05"(ソート用) */
function timeKey_(t) {
  return ('00000' + t).slice(-5);
}

// ---------------------------------------------------------------- API(クライアントから google.script.run で呼び出し)

/** 起動時データ: マスタ+本日のチェックイン */
function apiGetBootstrap_() {
  ensureSchema_();
  return {
    apiVersion: 5,
    capabilities: ['checkout', 'cognitive', 'assessments', 'communicationBook', 'staffLogin'],
    users: allUsers_(),
    exercises: allExercises_(),
    today: todayStr_(),
    staff: currentStaffName_() || '職員',
    role: CURRENT_STAFF_ ? CURRENT_STAFF_.role : 'staff',
    todayCheckins: apiGetTodayCheckins_(),
  };
}

function apiGetTodayCheckins_() {
  var today = todayStr_();
  return allCheckins_()
    .filter(function (c) { return c.date === today; })
    .sort(function (a, b) { return timeKey_(b.time) < timeKey_(a.time) ? -1 : 1; });
}

/** チェックイン登録。既存なら既存レコードを返す */
function apiCheckin_(userId) {
  if (!allUsers_().some(function (u) { return u.id === userId; })) throw new Error('利用者が見つかりません。');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var today = todayStr_();
    var allCheckins = allCheckins_();
    var existing = allCheckins.filter(function (c) {
      return c.date === today && c.userId === userId;
    });
    if (existing.length) {
      var current = allCheckins.filter(function (c) { return c.date === today; })
        .sort(function (a, b) { return timeKey_(b.time) < timeKey_(a.time) ? -1 : 1; });
      return { record: existing[0], already: true, todayCheckins: current };
    }
    var rec = {
      id: newId_(), date: today, time: nowTime_(), userId: userId,
      checkoutTime: '', transport: '',
    };
    appendRowNoLock_('checkins', [rec.id, rec.date, rec.time, rec.userId, '', '', currentStaffName_()]);
    var todayCheckins = allCheckins.filter(function (c) { return c.date === today; });
    todayCheckins.push(rec);
    todayCheckins.sort(function (a, b) { return timeKey_(b.time) < timeKey_(a.time) ? -1 : 1; });
    return { record: rec, already: false, todayCheckins: todayCheckins };
  } finally {
    lock.releaseLock();
  }
}

/** 帰苑時刻と送迎区分を登録する。 */
function apiCheckout_(userId, transport) {
  var allowed = ['施設送迎', 'ご家族送迎', 'その他'];
  if (allowed.indexOf(String(transport)) < 0) throw new Error('送迎区分を選択してください。');
  var today = todayStr_();
  var rec = null;
  allCheckins_().forEach(function (c) {
    if (c.userId === userId && c.date === today) rec = c;
  });
  if (!rec) throw new Error('本日の来苑記録がありません。');
  var sh = sheet_('checkins');
  var row = findRowById_(sh, rec.id);
  if (row < 0) throw new Error('来苑記録が見つかりません。');
  var checkoutTime = nowTime_();
  sh.getRange(row, 5, 1, 2).setNumberFormat('@').setValues([[checkoutTime, String(transport)]]);
  invalidateRequestRows_('checkins');
  return { id: rec.id, checkoutTime: checkoutTime, transport: String(transport) };
}

/** 受付画面のポーリング用: 日付跨ぎ検知と他端末のチェックイン反映 */
function apiRefreshToday_() {
  return { today: todayStr_(), todayCheckins: apiGetTodayCheckins_() };
}

/** 利用者一覧用: 本日アラートのある利用者IDマップ */
function apiGetTodayAlerts_() {
  var today = todayStr_();
  var map = {};
  allVitals_().forEach(function (v) {
    if (v.date === today && v.flagged) map[v.userId] = true;
  });
  return map;
}

/** 利用者詳細画面用: 必要データを1往復でまとめて返す */
function apiGetUserDetail_(userId) {
  var today = todayStr_();
  var checkins = allCheckins_().filter(function (c) { return c.userId === userId; });
  var vitals = allVitals_()
    .filter(function (v) { return v.userId === userId; })
    .sort(function (a, b) {
      return (a.date + timeKey_(a.time)) < (b.date + timeKey_(b.time)) ? -1 : 1;
    });
  var records = allRecords_().filter(function (e) { return e.userId === userId; });
  var cognitive = allCognitive_()
    .filter(function (e) { return e.userId === userId; })
    .sort(function (a, b) { return (a.date + timeKey_(a.time)) < (b.date + timeKey_(b.time)) ? -1 : 1; });
  var assessments = allAssessments_()
    .filter(function (e) { return e.userId === userId; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  var todayCheckin = null;
  checkins.forEach(function (c) { if (c.date === today && !todayCheckin) todayCheckin = c; });
  var todayVitals = vitals.filter(function (v) { return v.date === today; });

  // 直近5来所日の訓練サマリー(降順)
  var dates = {};
  checkins.forEach(function (c) { dates[c.date] = c.time; });
  var recentDays = Object.keys(dates).sort().reverse().slice(0, 5).map(function (date) {
    var dayEx = records
      .filter(function (e) { return e.date === date; })
      .sort(function (a, b) { return timeKey_(a.time) < timeKey_(b.time) ? -1 : 1; });
    return {
      date: date,
      time: dates[date],
      exercises: dayEx,
      note: dayEx.map(function (e) { return e.note; }).filter(String).join(' '),
    };
  });

  return {
    todayCheckin: todayCheckin,
    todayVital: todayVitals.length ? todayVitals[todayVitals.length - 1] : null,
    todayExercises: records
      .filter(function (e) { return e.date === today; })
      .sort(function (a, b) { return timeKey_(a.time) < timeKey_(b.time) ? -1 : 1; }),
    vitalsAll: vitals,
    recentDays: recentDays,
    alertHistory: vitals.filter(function (v) { return v.flagged; }).reverse().slice(0, 10),
    cognitiveRecords: cognitive.reverse().slice(0, 10),
    assessments: assessments.reverse().slice(0, 12),
  };
}

// ---------------------------------------------------------------- 管理者専用(利用者マスタCRUD)

/**
 * 管理者PIN検証。スクリプトプロパティ ADMIN_PIN に設定した値と照合する。
 * 未設定の間は誰でも通る(画面に設定を促す警告を表示)。
 */
// ================================================================ 職員ログイン
//
// 職員マスタに登録した職員が、自分の名前を選んで PIN でログインする。
// ログインすると署名付きセッション(有効12時間)が発行され、以降のAPIは
// このセッションを必須とする。権限は 'admin'(管理者)と 'staff'(現場職員)。
//   - staff: 受付・記録・利用者情報の閲覧のみ
//   - admin: 上記に加えて管理画面(利用者管理・職員管理・帳票など)

/** 現在のリクエストでログイン中の職員(記録者の記名に使う) */
var CURRENT_STAFF_ = null;

var SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 1勤務分

/** セッション署名用の秘密鍵。無ければ自動生成して保存する */
function sessionSecret_() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SESSION_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('SESSION_SECRET', secret);
  }
  return secret;
}

function toHex_(bytes) {
  return bytes.map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

/** PIN用のペッパー。セッション署名鍵とは分離し、片方の漏洩が他方に波及しないようにする */
function pinPepper_() {
  var props = PropertiesService.getScriptProperties();
  var pepper = props.getProperty('PIN_PEPPER');
  if (!pepper) {
    pepper = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('PIN_PEPPER', pepper);
  }
  return pepper;
}

/** PINはソルト+ペッパー付きでハッシュ化して保存する(シートに平文を残さない) */
function hashPin_(staffId, pin, salt) {
  var raw = String(staffId) + ':' + String(salt || '') + ':' + String(pin) + ':' + pinPepper_();
  return toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8));
}

/** よくある推測されやすいPINを拒否する */
function isWeakPin_(pin) {
  var t = String(pin);
  if (/^(\d)\1*$/.test(t)) return true;                 // 0000, 111111
  if ('0123456789012'.indexOf(t) >= 0) return true;      // 1234, 456789
  if ('9876543210987'.indexOf(t) >= 0) return true;      // 4321
  return false;
}

function signSession_(payload) {
  return toHex_(Utilities.computeHmacSha256Signature(payload, sessionSecret_()));
}

function makeSession_(staff) {
  var payload = staff.id + '.' + staff.sessionEpoch + '.' + (Date.now() + SESSION_TTL_MS);
  return payload + '.' + signSession_(payload);
}

/** セッション検証。改ざん・期限切れは例外 */
function verifySession_(session) {
  var text = String(session || '');
  var idx = text.lastIndexOf('.');
  if (idx < 0) throw new Error('ログインが必要です');
  var payload = text.slice(0, idx);
  var sig = text.slice(idx + 1);
  if (sig !== signSession_(payload)) throw new Error('ログインが必要です');
  var parts = payload.split('.');
  if (parts.length !== 3) throw new Error('ログインが必要です');
  if (Number(parts[2]) < Date.now()) throw new Error('ログインの有効期限が切れました。もう一度ログインしてください');
  var staff = null;
  allStaff_().forEach(function (s) { if (s.id === parts[0]) staff = s; });
  if (!staff || !staff.active) throw new Error('この職員アカウントは利用できません');
  // PIN変更・強制ログアウト後の古いセッションを無効化する
  if (String(staff.sessionEpoch) !== parts[1]) {
    throw new Error('ログインの有効期限が切れました。もう一度ログインしてください');
  }
  // 権限はシートの現在値を正とする(降格が即時反映される)
  return staff;
}

function toStaff_(r) {
  return {
    id: String(r[0]), name: String(r[1]), kana: String(r[2] || ''),
    jobTitle: String(r[3] || ''), role: String(r[4] || 'staff') === 'admin' ? 'admin' : 'staff',
    pinHash: String(r[5] || ''), active: String(r[6] || 'true') !== 'false',
    pinSalt: String(r[7] || ''), sessionEpoch: String(r[8] || '1'),
  };
}

function allStaff_() {
  return rows_('staff').map(toStaff_);
}

function currentStaffName_() {
  return CURRENT_STAFF_ ? CURRENT_STAFF_.name : '';
}

/**
 * ログイン画面用の職員一覧。
 * 未認証で呼べるため、氏名と職種のみ返し、権限は伏せる(総当たり対象の特定を防ぐ)。
 */
function apiGetStaffList_() {
  var list = allStaff_().filter(function (s) { return s.active && s.pinHash; }).map(function (s) {
    return { id: s.id, name: s.name, kana: s.kana, jobTitle: s.jobTitle };
  });
  return { staff: list, needsSetup: !list.length };
}

/**
 * 初回のみ: 管理者アカウントを作成する。
 * setup() から呼ばれる。未認証APIからは呼ばない(勝手に管理者を作られないため)。
 * PINはランダム発行し、実行ログに一度だけ表示する。
 */
function seedFirstAdmin_() {
  if (rows_('staff').length) return null;
  var pin = String(Math.floor(100000 + Math.random() * 900000)); // 6桁
  var id = 's' + Date.now().toString(36);
  var salt = Utilities.getUuid();
  appendRowNoLock_('staff', [id, '管理者', 'かんりしゃ', '管理者', 'admin', hashPin_(id, pin, salt), 'true', salt, '1']);
  invalidateRequestRows_('staff');
  Logger.log('管理者アカウントを作成しました。氏名「管理者」/ 初期PIN: ' + pin +
    '(ログイン後に「職員管理」で氏名とPINを変更してください)');
  return pin;
}

/**
 * ログイン。PINの連続失敗はスクリプトプロパティへ永続記録し、
 * ロック配下で読み書きするため並列リクエストによる総当たりを防ぐ。
 */
function apiLogin_(staffId, pin) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var key = 'login-fail-' + String(staffId).replace(/[^\w-]/g, '').slice(0, 40);
    var state = {};
    try { state = JSON.parse(props.getProperty(key) || '{}'); } catch (e) { state = {}; }
    if (state.lockedUntil && Number(state.lockedUntil) > Date.now()) {
      var mins = Math.ceil((Number(state.lockedUntil) - Date.now()) / 60000);
      throw new Error('PINの入力を続けて間違えました。約' + mins + '分後にもう一度お試しください');
    }

    var staff = null;
    allStaff_().forEach(function (x) { if (x.id === String(staffId)) staff = x; });
    var ok = !!(staff && staff.active && staff.pinHash &&
      staff.pinHash === hashPin_(staff.id, pin, staff.pinSalt));
    if (!ok) {
      var fails = Number(state.count || 0) + 1;
      // 5回失敗で15分、以降は失敗のたびに待ち時間を倍にする
      var next = { count: fails };
      if (fails >= 5) next.lockedUntil = Date.now() + Math.min(15 * 60000 * Math.pow(2, fails - 5), 6 * 3600000);
      props.setProperty(key, JSON.stringify(next));
      throw new Error(staff && staff.active ? 'PINが正しくありません' : 'この職員アカウントは利用できません');
    }
    props.deleteProperty(key);
    return {
      session: makeSession_(staff),
      staff: { id: staff.id, name: staff.name, role: staff.role, jobTitle: staff.jobTitle },
    };
  } finally {
    lock.releaseLock();
  }
}

/** ログイン中の職員情報(セッション復元時の確認用) */
function apiGetSession_() {
  var s = CURRENT_STAFF_;
  return { staff: { id: s.id, name: s.name, role: s.role, jobTitle: s.jobTitle } };
}

/** 職員の登録・更新(管理者のみ)。pin が空なら既存PINを維持 */
function apiAdminSaveStaff_(payload) {
  var name = String(payload.name || '').trim();
  if (!name) throw new Error('氏名を入力してください');
  var role = payload.role === 'admin' ? 'admin' : 'staff';
  var pin = String(payload.pin || '').trim();
  if (pin && !/^\d{4,8}$/.test(pin)) throw new Error('PINは4〜8桁の数字で入力してください');
  if (pin && isWeakPin_(pin)) throw new Error('推測されやすいPIN(1234や0000など)は使えません');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_('staff');
    var id = String(payload.id || '').trim();
    var existing = null;
    allStaff_().forEach(function (s) { if (s.id === id) existing = s; });
    if (id && !existing) throw new Error('対象の職員が見つかりません');
    if (!id) {
      id = 's' + Date.now().toString(36);
      if (!pin) throw new Error('新規登録にはPINが必要です');
    }
    // 管理者が誰もいなくなる変更は拒否する(締め出し防止)
    if (existing && existing.role === 'admin' && role !== 'admin' && adminCount_() <= 1) {
      throw new Error('管理者が0人になるため権限を変更できません');
    }
    // PINを変更したらセッション世代を進め、古い端末のログインを無効化する
    var salt = pin ? Utilities.getUuid() : (existing ? existing.pinSalt : Utilities.getUuid());
    var epoch = existing ? Number(existing.sessionEpoch || 1) : 1;
    if (pin && existing) epoch += 1;
    var row = [
      id, name, String(payload.kana || '').trim(), String(payload.jobTitle || '').trim(), role,
      pin ? hashPin_(id, pin, salt) : (existing ? existing.pinHash : ''),
      payload.active === false ? 'false' : 'true',
      salt, String(epoch),
    ];
    if (existing) {
      var idx = findRowIndexById_(sh, id);
      if (idx < 0) throw new Error('対象の職員が見つかりません');
      sh.getRange(idx, 1, 1, row.length).setNumberFormat('@').setValues([row.map(String)]);
    } else {
      appendRowNoLock_('staff', row);
    }
    invalidateRequestRows_('staff');
    return { staff: publicStaffList_() };
  } finally {
    lock.releaseLock();
  }
}

/** 職員の削除(管理者のみ)。最後の管理者は削除できない */
function apiAdminDeleteStaff_(staffId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var target = null;
    allStaff_().forEach(function (s) { if (s.id === String(staffId)) target = s; });
    if (!target) throw new Error('対象の職員が見つかりません');
    if (target.role === 'admin' && adminCount_() <= 1) throw new Error('最後の管理者は削除できません');
    if (CURRENT_STAFF_ && CURRENT_STAFF_.id === target.id) throw new Error('ログイン中の自分は削除できません');
    var sh = sheet_('staff');
    var idx = findRowIndexById_(sh, target.id);
    if (idx < 0) throw new Error('対象の職員が見つかりません');
    sh.deleteRow(idx);
    invalidateRequestRows_('staff');
    return { staff: publicStaffList_() };
  } finally {
    lock.releaseLock();
  }
}

function adminCount_() {
  return allStaff_().filter(function (s) { return s.role === 'admin' && s.active; }).length;
}

function publicStaffList_() {
  return allStaff_().map(function (s) {
    return {
      id: s.id, name: s.name, kana: s.kana, jobTitle: s.jobTitle,
      role: s.role, active: s.active, hasPin: !!s.pinHash,
    };
  });
}

/** 管理者向け: 職員一覧(権限・PIN設定状況つき) */
function apiAdminGetStaff_() {
  return { staff: publicStaffList_() };
}

/** 汎用: 1列目のIDで行番号(1始まり)を探す */
function findRowIndexById_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function adminPin_() {
  return PropertiesService.getScriptProperties().getProperty('ADMIN_PIN') || '';
}

/**
 * 端末ペアリング用のPIN照合。
 * 管理者アカウントのPIN、またはスクリプトプロパティ ADMIN_PIN と一致した場合のみ通す。
 * どちらも設定が無い場合は「素通り」させず必ず拒否する。
 */
function requireAdmin_(pin) {
  var candidate = String(pin || '');
  var matched = false;
  allStaff_().forEach(function (s) {
    if (s.role === 'admin' && s.active && s.pinHash &&
        s.pinHash === hashPin_(s.id, candidate, s.pinSalt)) matched = true;
  });
  var stored = adminPin_();
  if (!matched && stored && candidate === stored) matched = true;
  if (!matched) throw new Error('管理者PINが正しくありません');
}

function apiVerifyAdmin_(pin) {
  requireAdmin_(pin);
  return { ok: true, pinConfigured: !!adminPin_() };
}

/** 新しい端末を管理者PINでペアリングし、共有トークンを端末内へ渡す。 */
function apiPairDevice_(pin) {
  var cache = CacheService.getScriptCache();
  var failures = Number(cache.get('pair-failures') || 0);
  if (failures >= 10) throw new Error('認証試行が多すぎます。10分後にもう一度お試しください。');
  try {
    requireAdmin_(pin);
  } catch (err) {
    cache.put('pair-failures', String(failures + 1), 600);
    throw err;
  }
  var token = PropertiesService.getScriptProperties().getProperty('API_TOKEN') || '';
  if (!token) throw new Error('API_TOKENが未設定です。管理者へ連絡してください。');
  cache.remove('pair-failures');
  return { token: token };
}

/** 利用者の新規登録・更新(管理者のみ)。u.id が空なら新規 */
function apiAdminSaveUser_(u) {
  var name = String(u.name || '').trim();
  if (!name) throw new Error('氏名を入力してください');
  var age = Number(u.age);
  if (!isFinite(age) || age < 0 || age > 130) throw new Error('年齢が正しくありません');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_('users');
    var id = String(u.id || '').trim();
    var row = [
      '', name, String(age), String(u.careLevel || ''), String(u.scheduleLabel || ''),
      splitCsv_(String(u.plan || '')).join(','), '', String(u.kana || '').trim(),
      safeText_(u.goal, 500), safeText_(u.medicalHistory, 500), safeText_(u.precautions, 500),
    ];
    if (id) {
      var idx = findUserRowIndex_(sh, id);
      if (idx < 0) throw new Error('対象の利用者が見つかりません');
      row[0] = id;
      row[6] = 'GSU:' + id;
      sh.getRange(idx, 1, 1, row.length).setNumberFormat('@').setValues([row.map(String)]);
      invalidateRequestRows_('users');
      CacheService.getScriptCache().remove('master-v4-users');
    } else {
      id = 'u' + Date.now().toString(36);
      row[0] = id;
      row[6] = 'GSU:' + id;
      appendRowNoLock_('users', row);
    }
    return { users: allUsers_(), savedId: id };
  } finally {
    lock.releaseLock();
  }
}

/** 利用者の削除(管理者のみ)。過去の記録は残る */
function apiAdminDeleteUser_(userId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = sheet_('users');
    var idx = findUserRowIndex_(sh, userId);
    if (idx < 0) throw new Error('対象の利用者が見つかりません');
    sh.deleteRow(idx);
    invalidateRequestRows_('users');
    CacheService.getScriptCache().remove('master-v4-users');
    return { users: allUsers_() };
  } finally {
    lock.releaseLock();
  }
}

/** 利用者マスタからID一致行(1始まりの行番号)を探す */
function findUserRowIndex_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function findRowById_(sh, id) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function safeText_(value, max) {
  var text = String(value || '').trim();
  if (text.length > max) throw new Error(max + '文字以内で入力してください。');
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return text;
}

/** 記録の取り消し(論理削除)。 */
function apiVoidRecord_(kind, recordId) {
  if (['checkins', 'vitals', 'records', 'cognitive', 'assessments'].indexOf(kind) < 0) {
    throw new Error('取り消せない種別です: ' + kind);
  }
  appendRow_('voids', [String(recordId), SHEETS[kind],
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd H:mm:ss'),
    currentStaffName_()]);
  return { ok: true };
}

/** バイタル入力用コンテキスト: 前回値(本日より前の最新) */
function apiGetVitalContext_(userId) {
  var today = todayStr_();
  var prev = allVitals_()
    .filter(function (v) { return v.userId === userId && v.date < today; })
    .sort(function (a, b) {
      var ka = a.date + timeKey_(a.time);
      var kb = b.date + timeKey_(b.time);
      return ka < kb ? -1 : 1;
    });
  return { prev: prev.length ? prev[prev.length - 1] : null };
}

/**
 * バイタル保存。アラート判定はサーバー側で行い、該当時もフラグ付きで保存する。
 * payload: {userId, systolic, diastolic, pulse, temp, spo2, weight, conditionNote}
 */
function apiSaveVitals_(payload) {
  validateVitalPayload_(payload);
  var prev = apiGetVitalContext_(payload.userId).prev;
  var alerts = evaluateVitalAlerts_(payload, prev);
  // SpO2・体重は任意項目。未入力は 0 ではなく空(null)として保存する
  var rec = {
    id: newId_(), date: todayStr_(), time: nowTime_(), userId: payload.userId,
    systolic: Number(payload.systolic) || 0, diastolic: Number(payload.diastolic) || 0,
    pulse: Number(payload.pulse) || 0, temp: Number(payload.temp) || 0,
    spo2: String(payload.spo2) === '' ? null : Number(payload.spo2),
    weight: String(payload.weight) === '' ? null : Number(payload.weight),
    flagged: alerts.length > 0, alerts: alerts,
    conditionNote: safeText_(payload.conditionNote, 300),
  };
  appendRow_('vitals', [
    rec.id, rec.date, rec.time, rec.userId,
    rec.systolic, rec.diastolic, rec.pulse, rec.temp,
    rec.spo2 === null ? '' : rec.spo2, rec.weight === null ? '' : rec.weight,
    rec.flagged, rec.alerts.join(' / '), rec.conditionNote, currentStaffName_(),
  ]);
  return rec;
}

function validateVitalPayload_(payload) {
  if (!payload || !allUsers_().some(function (u) { return u.id === payload.userId; })) {
    throw new Error('利用者が見つかりません。');
  }
  var limits = {
    systolic: [60, 250], diastolic: [30, 150], pulse: [30, 220],
    temp: [30, 45], spo2: [50, 100], weight: [20, 250],
  };
  var optional = { spo2: true, weight: true };
  Object.keys(limits).forEach(function (key) {
    if (optional[key] && String(payload[key]) === '') return; // SpO2・体重は任意
    var value = Number(payload[key]);
    var range = limits[key];
    if (payload[key] === '' || !isFinite(value) || value < range[0] || value > range[1]) {
      throw new Error('バイタル値の形式または範囲が正しくありません。');
    }
  });
  if (Number(payload.diastolic) >= Number(payload.systolic)) {
    throw new Error('下の血圧は上の血圧より小さい値にしてください。');
  }
}

/** バイタル閾値判定(クライアントのライブ表示と同一ロジック) */
function evaluateVitalAlerts_(draft, prev) {
  var alerts = [];
  var sys = Number(draft.systolic);
  if (draft.systolic !== '' && !isNaN(sys)) {
    if (sys >= 160) {
      alerts.push('収縮期血圧が高値です(160以上)。運動可否を看護師に確認してください');
    } else if (prev && sys - prev.systolic >= 20) {
      alerts.push('収縮期血圧が前回より高めです。運動前に再測定を推奨');
    }
  }
  var spo2 = Number(draft.spo2);
  if (draft.spo2 !== '' && !isNaN(spo2) && spo2 <= 92) {
    alerts.push('SpO2が低めです(92%以下)。安静にして再測定してください');
  }
  var temp = Number(draft.temp);
  if (draft.temp !== '' && !isNaN(temp) && temp >= 37.5) {
    alerts.push('体温が高めです(37.5℃以上)。本日の運動可否を確認してください');
  }
  return alerts;
}

/** 訓練記録保存。payload: {userId, exerciseId, amount, load, note} */
function apiSaveExercise_(payload) {
  var userExists = allUsers_().some(function (u) { return u.id === payload.userId; });
  var exercise = allExercises_().filter(function (e) { return e.id === payload.exerciseId; })[0];
  if (!userExists || !exercise) throw new Error('利用者または訓練種目が見つかりません。');
  if (exercise.amountOptions.indexOf(String(payload.amount)) < 0) throw new Error('実施量が正しくありません。');
  if (['軽い', 'ふつう', '強い'].indexOf(String(payload.load)) < 0) throw new Error('負荷レベルが正しくありません。');
  var note = String(payload.note || '').trim();
  if (note.length > 200) throw new Error('所見は200文字以内で入力してください。');
  if (/^[=+\-@]/.test(note)) note = "'" + note;
  var rec = {
    id: newId_(), date: todayStr_(), time: nowTime_(),
    userId: payload.userId, exerciseId: payload.exerciseId,
    amount: String(payload.amount), load: String(payload.load), note: note,
  };
  appendRow_('records', [
    rec.id, rec.date, rec.time, rec.userId, rec.exerciseId, rec.amount, rec.load, rec.note,
    currentStaffName_(),
  ]);
  return { record: rec };
}

/** 当日の実施済み種目(時刻昇順) */
function apiGetTodayExercises_(userId) {
  var today = todayStr_();
  return allRecords_()
    .filter(function (e) { return e.userId === userId && e.date === today; })
    .sort(function (a, b) { return timeKey_(a.time) < timeKey_(b.time) ? -1 : 1; });
}

/** 脳トレの実施内容を記録する。 */
function apiSaveCognitive_(payload) {
  var userExists = allUsers_().some(function (u) { return u.id === payload.userId; });
  if (!userExists) throw new Error('利用者が見つかりません。');
  var activity = safeText_(payload.activity, 120);
  if (!activity) throw new Error('脳トレの実施内容を入力してください。');
  var rec = {
    id: newId_(), date: validDateStr_(payload.date || todayStr_()), time: nowTime_(), userId: payload.userId,
    activity: activity, note: safeText_(payload.note, 300),
  };
  appendRow_('cognitive', [rec.id, rec.date, rec.time, rec.userId, rec.activity, rec.note, currentStaffName_()]);
  return rec;
}

/** 体力測定・HDS-R・MMSEの結果を共通形式で記録する。 */
function apiSaveAssessment_(payload) {
  var userExists = allUsers_().some(function (u) { return u.id === payload.userId; });
  var allowed = ['体力測定', 'HDS-R', 'MMSE'];
  if (!userExists) throw new Error('利用者が見つかりません。');
  if (allowed.indexOf(String(payload.type)) < 0) throw new Error('評価種別を選択してください。');
  var result = safeText_(payload.result, 120);
  if (!result) throw new Error('評価結果を入力してください。');
  var rec = {
    id: newId_(), date: validDateStr_(payload.date || todayStr_()), userId: payload.userId,
    type: String(payload.type), result: result, detail: safeText_(payload.detail, 500),
  };
  appendRow_('assessments', [rec.id, rec.date, rec.userId, rec.type, rec.result, rec.detail, currentStaffName_()]);
  return rec;
}

/** 連絡帳作成に必要な1日分の記録をまとめて返す。 */
function apiGetCommunicationBook_(userId, date) {
  var user = allUsers_().filter(function (u) { return u.id === userId; })[0];
  if (!user) throw new Error('利用者が見つかりません。');
  var target = validDateStr_(date || todayStr_());
  var checkin = null;
  allCheckins_().forEach(function (c) {
    if (c.userId === userId && c.date === target) checkin = c;
  });
  var vital = null;
  allVitals_().forEach(function (v) {
    if (v.userId === userId && v.date === target && (!vital || timeKey_(v.time) >= timeKey_(vital.time))) vital = v;
  });
  var exercises = allRecords_()
    .filter(function (e) { return e.userId === userId && e.date === target; })
    .sort(function (a, b) { return timeKey_(a.time) < timeKey_(b.time) ? -1 : 1; });
  var cognitive = allCognitive_()
    .filter(function (e) { return e.userId === userId && e.date === target; })
    .sort(function (a, b) { return timeKey_(a.time) < timeKey_(b.time) ? -1 : 1; });
  return {
    user: { id: user.id, name: user.name, plan: user.plan }, date: target, checkin: checkin, vital: vital,
    exercises: exercises, cognitiveRecords: cognitive,
  };
}

/** 利用者別実績(管理画面 1d) */
function apiGetUserResults_(userId, month) {
  var checkins = allCheckins_();
  var months = {};
  checkins.forEach(function (c) { months[c.date.slice(0, 7)] = true; });

  var vitalsAll = allVitals_()
    .filter(function (v) { return v.userId === userId; })
    .sort(function (a, b) {
      var ka = a.date + timeKey_(a.time);
      var kb = b.date + timeKey_(b.time);
      return ka < kb ? -1 : 1;
    });

  function inMonth(d) { return d.slice(0, 7) === month; }
  return {
    months: Object.keys(months).sort().reverse(),
    vitalsAll: vitalsAll,
    monthCheckins: checkins.filter(function (c) { return c.userId === userId && inMonth(c.date); }),
    monthVitals: vitalsAll.filter(function (v) { return inMonth(v.date); }),
    monthExercises: allRecords_().filter(function (e) { return e.userId === userId && inMonth(e.date); }),
  };
}

/** 本日の記録一覧(管理画面) */
function apiGetTodayRecords_() {
  var today = todayStr_();
  return {
    checkins: apiGetTodayCheckins_(),
    vitals: allVitals_().filter(function (v) { return v.date === today; }),
    records: allRecords_().filter(function (e) { return e.date === today; }),
    cognitiveRecords: allCognitive_().filter(function (e) { return e.date === today; }),
  };
}

/** 月次レポート(管理画面) */
function apiGetMonthly_(month) {
  var checkins = allCheckins_();
  var months = {};
  checkins.forEach(function (c) { months[c.date.slice(0, 7)] = true; });
  function inMonth(d) { return d.slice(0, 7) === month; }
  return {
    months: Object.keys(months).sort().reverse(),
    checkins: checkins.filter(function (c) { return inMonth(c.date); }),
    vitals: allVitals_().filter(function (v) { return inMonth(v.date); }),
    records: allRecords_().filter(function (e) { return inMonth(e.date); }),
  };
}

// ---------------------------------------------------------------- セットアップ

/**
 * 初回セットアップ: シート作成のみ(本番運用向け。エディタから一度実行)。
 * デモデータ込みで試したい場合は setupWithDemoData() を実行する。
 */
function setup() {
  return setup_(false);
}

/** シート作成+デモデータ投入(動作確認用) */
function setupWithDemoData() {
  return setup_(true);
}

function setup_(withDemo) {
  var ss = SpreadsheetApp.getActive();
  if (!ss) {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('SPREADSHEET_ID');
    if (id) {
      ss = SpreadsheetApp.openById(id);
    } else {
      ss = SpreadsheetApp.create('機能訓練記録DB(銀松苑)');
      props.setProperty('SPREADSHEET_ID', ss.getId());
    }
  }

  Object.keys(SHEETS).forEach(function (key) {
    var name = SHEETS[key];
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      // 日付・時刻が Date 型に自動変換されないよう全列テキスト書式にする
      sh.getRange(1, 1, sh.getMaxRows(), HEADERS[key].length).setNumberFormat('@');
      sh.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]])
        .setFontWeight('bold').setBackground('#E3F1E1');
      sh.setFrozenRows(1);
    } else {
      // 既存シートの列追加マイグレーション(例: 利用者マスタの「ふりがな」)
      sh.getRange(1, 1, sh.getMaxRows(), HEADERS[key].length).setNumberFormat('@');
      sh.getRange(1, 1, 1, HEADERS[key].length).setValues([HEADERS[key]])
        .setFontWeight('bold').setBackground('#E3F1E1');
    }
  });

  var def = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > Object.keys(SHEETS).length) ss.deleteSheet(def);

  // 初回のみ管理者アカウントを作成(PINは実行ログに表示される)
  var seededPin = seedFirstAdmin_();
  // デモ投入は明示実行時のみ+利用者マスタが空の場合に限る(本番データへの混入防止)
  if (withDemo && sheet_('users').getLastRow() < 2) seedData_();
  if (seededPin) {
    Logger.log('★ 最初のログイン: 氏名「管理者」/ PIN ' + seededPin);
  }
  Logger.log('セットアップ完了: ' + ss.getUrl());
  return ss.getUrl();
}

function seedData_() {
  var exercises = [
    ['ergo', 'エルゴメーター', 'エルゴ', '実施時間', '10分,15分,20分', 'GSE:ergo'],
    ['walk', '平行棒内歩行', '歩行', '実施量', '3往復,5往復,7往復', 'GSE:walk'],
    ['legpress', 'レッグプレス', 'レッグプレス', '実施回数', '10回×2,15回×2,20回×2', 'GSE:legpress'],
    ['ball', 'ボール体操', 'ボール体操', '実施時間', '10分,15分,20分', 'GSE:ball'],
    ['band', 'セラバンド', 'セラバンド', '実施回数', '10回,15回,20回', 'GSE:band'],
  ];
  var users = [
    ['u01', '田中 花子', 82, '要介護2', '月/木', 'walk,legpress,ball,ergo', 'たなか はなこ'],
    ['u02', '佐藤 一郎', 78, '要支援1', '月/水', 'walk,ergo,band', 'さとう いちろう'],
    ['u03', '鈴木 良子', 85, '要介護1', '月/金', 'walk,ball,band', 'すずき よしこ'],
    ['u04', '高橋 正夫', 80, '要介護3', '月/木', 'walk,legpress,ergo', 'たかはし まさお'],
    ['u05', '伊藤 幸子', 76, '要支援2', '月/水', 'ergo,ball,band', 'いとう さちこ'],
    ['u06', '渡辺 茂', 88, '要介護2', '月/金', 'walk,ball', 'わたなべ しげる'],
    ['u07', '山本 静江', 79, '要介護1', '月/木', 'walk,legpress,band', 'やまもと しずえ'],
    ['u08', '中村 勝', 83, '要支援1', '月/水', 'ergo,walk', 'なかむら まさる'],
    ['u09', '小林 富美', 81, '要介護2', '月/金', 'ball,band,walk', 'こばやし ふみ'],
    ['u10', '加藤 秀雄', 77, '要支援2', '月/木', 'ergo,legpress', 'かとう ひでお'],
    ['u11', '吉田 春江', 86, '要介護3', '月/水', 'walk,ball', 'よしだ はるえ'],
    ['u12', '佐々木 実', 74, '要支援1', '月/金', 'ergo,band,walk', 'ささき みのる'],
  ];

  var shEx = sheet_('exercises');
  exercises.forEach(function (r) { shEx.appendRow(r.map(String)); });
  var shUsers = sheet_('users');
  users.forEach(function (r) {
    var goal = r[0] === 'u01' ? '屋内を安全に歩き、日常生活の活動量を保つ' : '体力を維持し、安全に在宅生活を続ける';
    var history = r[0] === 'u01' ? '高血圧、変形性膝関節症' : '';
    var precautions = r[0] === 'u01' ? '左膝の痛みに注意。疼痛時は歩行負荷を調整する' : '';
    shUsers.appendRow([r[0], r[1], String(r[2]), r[3], r[4], r[5], 'GSU:' + r[0], r[6] || '', goal, history, precautions]);
  });

  // 田中花子: 過去7回分の履歴(グラフ・前回値参照用)
  var tz = Session.getScriptTimeZone();
  var dates = [];
  var d = new Date();
  d.setDate(d.getDate() - 3);
  var gap3 = false;
  while (dates.length < 7) {
    dates.push(Utilities.formatDate(d, tz, 'yyyy-MM-dd'));
    d.setDate(d.getDate() - (gap3 ? 3 : 4));
    gap3 = !gap3;
  }
  var hist = [
    [128, 74, 70, 36.2, 97, 52.5, '9:08', [['walk', '5往復', '意欲高い。'], ['ball', '15分', ''], ['ergo', '15分', '']]],
    [121, 72, 68, 36.3, 98, 52.4, '9:15', [['walk', '5往復', '左膝の痛み訴えなし。'], ['band', '15回', ''], ['ergo', '10分', '']]],
    [130, 75, 71, 36.4, 97, 52.6, '9:10', [['walk', '3往復', ''], ['legpress', '15回×2', 'フォーム良好。'], ['ergo', '15分', '']]],
    [125, 72, 68, 36.3, 97, 52.7, '9:12', [['walk', '5往復', ''], ['ball', '10分', ''], ['ergo', '15分', 'ペース安定。']]],
    [131, 76, 72, 36.5, 96, 52.8, '9:06', [['walk', '5往復', ''], ['legpress', '10回×2', ''], ['ergo', '10分', '']]],
    [124, 73, 69, 36.2, 98, 52.9, '9:14', [['walk', '3往復', '疲労の訴えあり、負荷軽め。'], ['band', '10回', ''], ['ergo', '10分', '']]],
    [129, 74, 71, 36.4, 97, 53.0, '9:09', [['walk', '5往復', ''], ['ball', '15分', ''], ['ergo', '15分', '']]],
  ];
  var shC = sheet_('checkins');
  var shV = sheet_('vitals');
  var shR = sheet_('records');
  var shCog = sheet_('cognitive');
  var shAss = sheet_('assessments');

  // 本日の来所状況デモ: 8名チェックイン済(デザインモックアップ準拠)
  var today = todayStr_();
  [['u02', '9:05'], ['u04', '8:58'], ['u05', '9:02'], ['u07', '9:15'],
   ['u08', '9:18'], ['u10', '9:03'], ['u11', '9:09'], ['u12', '9:20']].forEach(function (c) {
    shC.appendRow([newId_(), today, c[1], c[0]]);
  });
  // 佐藤一郎は本日バイタル測定・歩行1種目まで実施済(記録一覧のデモ用)
  shV.appendRow([newId_(), today, '9:12', 'u02', '118', '70', '66', '36.1', '98', '61.2', 'false', '']);
  shR.appendRow([newId_(), today, '9:35', 'u02', 'walk', '5往復', 'ふつう', '']);
  shCog.appendRow([newId_(), today, '10:20', 'u02', '計算プリント', '20問中18問正解。集中して取り組まれた。']);
  shAss.appendRow([newId_(), dates[0], 'u01', 'HDS-R', '24/30点', '見当識は良好。遅延再生で減点あり。']);
  shAss.appendRow([newId_(), dates[0], 'u01', '体力測定', 'TUG 13.2秒', '前回より0.8秒短縮。']);

  dates.forEach(function (date, i) {
    var h = hist[i];
    shC.appendRow([newId_(), date, h[6], 'u01']);
    shV.appendRow([newId_(), date, h[6], 'u01', String(h[0]), String(h[1]), String(h[2]), String(h[3]), String(h[4]), String(h[5]), 'false', '']);
    var hour = 9;
    var min = 40;
    h[7].forEach(function (m) {
      shR.appendRow([newId_(), date, hour + ':' + ('0' + min).slice(-2), 'u01', m[0], m[1], 'ふつう', m[2]]);
      min += 25;
      if (min >= 60) { min -= 60; hour += 1; }
    });
  });
}
