/* =========================================================================
   Plate Motion Lab — script.js
   손동작(또는 마우스)으로 두 판의 상대 운동을 만들고,
   발산형 / 수렴형 / 보존형 경계와 지각 변동을 시각화하는 학습 데모.

   구조
     1) CONFIG            조정 가능한 상수
     2) appState          전역 상태
     3) CONTENT / MISSIONS 학습 콘텐츠 데이터
     4) DOM               요소 참조
     5) 유틸
     6) 카메라 + MediaPipe
     7) 손 좌표 · 히스토리 · 이동 벡터
     8) 경계 판별
     9) 시뮬레이션 상태(판 변위 · 응력 · 지진)
    10) 렌더링(카메라 / 시뮬레이션)
    11) 정보 패널
    12) 미션 · 튜토리얼 · 모달
    13) 수동 조작 모드 · 사운드
    14) 메인 루프 · 이벤트 바인딩
   ========================================================================= */

/* =========================================================================
   1) CONFIG — 카메라 테스트 후 이 값만 조정하면 됩니다.
   ========================================================================= */
const CONFIG = {
  hand: {
    smoothingAlpha:    0.35,   // EMA 계수 (클수록 반응 빠름 / 떨림 증가)
    historyMs:         900,    // 좌표 히스토리 보관 시간
    recentWindowMs:    220,    // "최근" 평균 구간
    pastWindowStartMs: 420,    // "과거" 평균 구간 시작(현재로부터)
    pastWindowEndMs:   780,    // "과거" 평균 구간 끝(현재로부터)
    lostGraceMs:       800,    // 손이 사라져도 추적을 유지하는 시간
    minHandSpan:       0.085,  // 손 bounding box 최소 크기(너무 멀면 경고)
    edgeMargin:        0.03,   // 화면 밖 판정 여유
    // 상대 운동 임계값(정규화 좌표, 두 손의 "상대" 변위 기준)
    separationThreshold: 0.040, // 벌어짐/모임 판정
    shearThreshold:      0.040, // 엇갈림 판정
    dominanceRatio:      1.25,  // 주된 성분이 다른 성분보다 몇 배 커야 하는가
    stableStateMs:       450    // 후보 상태 유지 시간(debounce)
  },

  sim: {
    plateGain:   2.6,   // 상대 속도 → 판 변위 변환 계수
    shearGain:   140,   // 상대 속도 → 보존형 변형량(px)
    maxElastic:  74,    // 고착 구간에서 쌓이는 최대 탄성 변형(px)
    relaxRate:   0.05   // IDLE일 때 변위가 서서히 되돌아가는 비율
  },

  stress: {
    max:                100,
    earthquakeThreshold: 85,
    postEarthquake:      30,
    baseRate:             9,   // 상태 유지 시 기본 증가율(/초)
    speedRate:           95,   // 상대 속도 비례 증가율
    decayRate:            4    // 비활성 시 감소율(/초)
  },

  mission: { successHoldMs: 1000 },

  speed: { slow: 0.055, fast: 0.16 }, // 상대 속도(정규화/초) 3단계 구분점

  camera: { width: 640, height: 480 }
};

/* ---- MediaPipe 자산 위치 ----------------------------------------------
   vendor/ 폴더에 파일이 있으면 로컬(오프라인)에서 불러오고,
   없으면 자동으로 CDN으로 넘어간다. 학교 네트워크가 외부를 막아도 동작한다. */
const MP_VERSION = '0.10.14';

const MP_LOCAL = {
  name:   '로컬(vendor)',
  bundle: './vendor/vision_bundle.mjs',
  wasm:   './vendor/wasm',
  model:  './vendor/models/hand_landmarker.task'
};
const MP_CDN = {
  name:   'CDN',
  bundle: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`,
  wasm:   `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`,
  model:  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
};

/** 파일이 실제로 존재하는지 확인 (file:// 이거나 404면 false) */
async function assetExists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.ok;
  } catch { return false; }
}

/** 로컬 자산이 모두 있으면 로컬, 아니면 CDN을 쓴다 */
async function resolveMediaPipeAssets() {
  const checks = await Promise.all([
    assetExists(MP_LOCAL.bundle),
    assetExists(MP_LOCAL.wasm + '/vision_wasm_internal.js'),
    assetExists(MP_LOCAL.model)
  ]);
  const src = checks.every(Boolean) ? MP_LOCAL : MP_CDN;
  console.info(`[Plate Motion Lab] MediaPipe 자산: ${src.name}`);
  return src;
}

/* =========================================================================
   2) 전역 상태
   ========================================================================= */
const appState = {
  mode: 'free',              // 'free' | 'mission'
  cameraRunning: false,
  manualMode: false,
  handsDetected: 0,
  handStatus: 'IDLE_CAMERA', // 상태 문자열(안내 메시지용)

  boundary: 'IDLE',          // IDLE | DIVERGENT | CONVERGENT | TRANSFORM | UNCERTAIN
  candidateBoundary: 'IDLE',
  candidateSince: 0,
  boundarySince: 0,

  handA: null,               // { x, y }  화면상 왼쪽 손 = 판 A
  handB: null,               // { x, y }  화면상 오른쪽 손 = 판 B
  lastSeenAt: 0,

  separation: 0,             // 상대 변위의 경계축 성분 (+ 벌어짐)
  shear: 0,                  // 상대 변위의 경계축 수직 성분
  relSpeed: 0,               // 상대 속도(정규화/초)
  axis: { x: 1, y: 0 },      // 판 경계축(A→B 단위벡터, 평활화됨)

  convergenceType: 'oceanic-continental',

  plateOffset: 0,            // -1(최대 압축) ~ +1(최대 확장)
  slip: 0,                   // 보존형: 누적 미끄러짐(px)
  elastic: 0,                // 보존형: 고착으로 쌓인 탄성 변형(px)
  shearDir: 1,               // 보존형 이동 방향 부호

  crustCreated: 0,
  crustConsumed: 0,

  stress: 0,
  quakeWaves: [],
  shake: 0,
  quakeBadgeUntil: 0,
  lastQuakeAt: 0,
  epicenter: { x: 0, y: 0 },

  landmarkVisible: true,
  soundEnabled: false,
  debugVisible: false,

  missionIndex: 0,
  missionHold: 0,
  missionActive: false,
  quizAnswer: null,

  records: []
};

// 손별 추적 데이터
const tracks = {
  A: { smooth: null, history: [] },
  B: { smooth: null, history: [] }
};

// 수동 조작용 가상 손 위치(정규화 좌표)
const manualHands = { A: { x: 0.32, y: 0.5 }, B: { x: 0.68, y: 0.5 }, selected: 'A', dragging: null };

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* =========================================================================
   3) 학습 콘텐츠
   ========================================================================= */
const CONV_LABEL = {
  'oceanic-continental':     '해양판 + 대륙판',
  'oceanic-oceanic':         '해양판 + 해양판',
  'continental-continental': '대륙판 + 대륙판'
};

const CONTENT = {
  IDLE: {
    motion: '정지 또는 매우 느림',
    boundary: '–',
    land: '–',
    phenomena: ['판이 거의 움직이지 않고 있습니다.'],
    quake: '없음', volcano: '없음', create: false, consume: false,
    concept: '두 손(또는 두 원)을 움직여 판의 상대 운동을 만들어 보세요.',
    example: '–',
    badge: '대기', badgeClass: 'badge-idle'
  },
  UNCERTAIN: {
    motion: '판별 중',
    boundary: '판별 중',
    land: '–',
    phenomena: ['움직임이 작거나 방향이 섞여 있습니다.'],
    quake: '–', volcano: '–', create: false, consume: false,
    concept: '판 운동을 조금 더 크고 분명하게 보여 주세요. 벌리기 · 모으기 · 엇갈리기 중 하나로 확실하게 움직이면 판별됩니다.',
    example: '–',
    badge: '판별 중', badgeClass: 'badge-uncertain'
  },
  DIVERGENT: {
    motion: '서로 멀어짐',
    boundary: '발산형 경계',
    land: '해령(또는 열곡)',
    phenomena: ['아래의 뜨거운 맨틀 물질이 상승', '마그마 생성', '새로운 해양 지각 생성', '해령 또는 열곡 형성'],
    quake: '있음(얕은 지진)', volcano: '있음(해령의 화산 활동)', create: true, consume: false,
    concept: '판이 벌어지는 곳에서는 아래의 뜨거운 물질이 상승하고 마그마가 만들어져 새로운 지각이 형성될 수 있습니다.',
    example: '대서양 중앙 해령, 동아프리카 열곡대',
    badge: '발산형 경계', badgeClass: 'badge-divergent'
  },
  TRANSFORM: {
    motion: '서로 어긋나며 스쳐 지나감',
    boundary: '보존형 경계',
    land: '변환 단층',
    phenomena: ['두 판이 경계를 따라 반대 방향으로 이동', '마찰 때문에 경계가 고착되어 응력이 쌓임', '임계값에서 갑자기 미끄러짐', '지진 발생'],
    quake: '있음(주로 얕은 지진)', volcano: '주요 현상 아님', create: false, consume: false,
    concept: '보존형 경계에서는 지각이 새로 만들어지거나 없어지지 않습니다. 두 판이 수평으로 어긋나면서 쌓인 응력이 갑작스러운 단층 운동, 즉 지진으로 방출됩니다.',
    example: '산안드레아스 단층',
    badge: '보존형 경계', badgeClass: 'badge-transform'
  },
  'CONVERGENT/oceanic-continental': {
    motion: '서로 가까워짐',
    boundary: '수렴형 경계',
    land: '해구 · 화산 · 습곡 산맥',
    phenomena: ['밀도가 큰 해양판이 대륙판 아래로 섭입', '해구 형성', '섭입대를 따라 얕은 곳부터 깊은 곳까지 지진', '마그마 상승 → 화산 활동'],
    quake: '있음(깊은 지진까지)', volcano: '있음', create: false, consume: true,
    concept: '밀도가 큰 해양판이 대륙판 아래로 섭입하면서 깊은 해구가 만들어지고, 섭입대 위쪽에서 마그마가 생성되어 화산 활동이 일어납니다.',
    example: '안데스산맥 주변(남아메리카판–나스카판 경계)',
    badge: '수렴형 경계 · 해양–대륙', badgeClass: 'badge-convergent'
  },
  'CONVERGENT/oceanic-oceanic': {
    motion: '서로 가까워짐',
    boundary: '수렴형 경계',
    land: '깊은 해구 · 호상 열도',
    phenomena: ['한 해양판이 다른 해양판 아래로 섭입', '깊은 해구 형성', '화산섬(호상 열도) 형성', '섭입대를 따라 지진'],
    quake: '있음(깊은 지진까지)', volcano: '있음(화산섬)', create: false, consume: true,
    concept: '두 해양판이 만나면 상대적으로 무거운 판이 섭입하여 깊은 해구가 생기고, 그 옆으로 줄지어 화산섬(호상 열도)이 만들어집니다.',
    example: '일본 주변, 마리아나 해구',
    badge: '수렴형 경계 · 해양–해양', badgeClass: 'badge-convergent'
  },
  'CONVERGENT/continental-continental': {
    motion: '서로 가까워짐',
    boundary: '수렴형 경계',
    land: '높은 습곡 산맥',
    phenomena: ['두 대륙판이 충돌', '지각이 압축되어 두꺼워짐', '지층이 휘어져 습곡 형성', '높은 산맥 형성 · 지진 발생'],
    quake: '있음(주로 얕은 지진)', volcano: '뚜렷하지 않음', create: false, consume: false,
    concept: '두 대륙판은 밀도가 비슷해 잘 섭입하지 않습니다. 대신 지각이 압축되고 두꺼워지면서 높은 습곡 산맥이 만들어집니다. 화산 활동은 주요 결과가 아닙니다.',
    example: '히말라야산맥',
    badge: '수렴형 경계 · 대륙–대륙', badgeClass: 'badge-convergent'
  }
};

function contentFor(boundary, convType) {
  if (boundary === 'CONVERGENT') return CONTENT[`CONVERGENT/${convType}`];
  return CONTENT[boundary] || CONTENT.IDLE;
}

const MISSIONS = [
  {
    title: '발산형 경계 만들기',
    desc: '두 판을 서로 멀어지게 하여 발산형 경계를 만들어 보세요.',
    hint: '←   →',
    type: 'hold',
    check: () => appState.boundary === 'DIVERGENT',
    success: '성공! 발산형 경계에서는 뜨거운 물질이 상승하고 마그마가 만들어져 새로운 지각이 생성될 수 있습니다.',
    quiz: {
      q: '두 판이 서로 멀어진다면 어떤 변화가 나타날까요?',
      options: ['새로운 지각이 생성될 수 있다.', '거대한 습곡 산맥만 형성된다.', '아무 변화도 일어나지 않는다.'],
      answer: 0,
      review: '정답은 A입니다. 판이 벌어지는 곳에서는 맨틀 물질이 상승하고 마그마가 만들어져 새로운 지각이 형성됩니다.'
    }
  },
  {
    title: '해양판과 대륙판의 수렴형 경계',
    desc: '해양판과 대륙판이 만나는 수렴형 경계를 만들어 보세요. 무엇이 아래로 들어가는지 관찰하세요.',
    hint: '→   ←',
    type: 'hold',
    preset: 'oceanic-continental',
    check: () => appState.boundary === 'CONVERGENT' && appState.convergenceType === 'oceanic-continental',
    success: '성공! 밀도가 큰 해양판이 대륙판 아래로 섭입하면서 해구와 화산이 만들어집니다.'
  },
  {
    title: '화산보다 거대한 산맥이 만들어지는 경계',
    desc: '판의 종류를 직접 골라, 화산보다 거대한 산맥이 만들어지는 경계를 만들어 보세요.',
    hint: '→   ←',
    type: 'hold',
    choose: true,
    check: () => appState.boundary === 'CONVERGENT' && appState.convergenceType === 'continental-continental',
    success: '성공! 대륙판끼리 충돌하면 잘 섭입하지 않고 지각이 압축·융기하여 히말라야 같은 높은 습곡 산맥이 만들어집니다.',
    quiz: {
      q: '히말라야산맥처럼 매우 높은 산맥은 어떤 경계에서 만들어질까요?',
      options: ['해양판 + 대륙판 수렴형', '대륙판 + 대륙판 수렴형', '보존형 경계'],
      answer: 1,
      review: '정답은 B입니다. 밀도가 비슷한 두 대륙판은 섭입하지 못하고 충돌하여 두꺼운 습곡 산맥을 만듭니다.'
    }
  },
  {
    title: '보존형 경계 만들기',
    desc: '두 판이 서로 스쳐 지나가도록 위아래로 엇갈리게 움직여 보존형 경계를 만들어 보세요.',
    hint: '↑   ↓',
    type: 'hold',
    check: () => appState.boundary === 'TRANSFORM',
    success: '성공! 보존형 경계에서는 지각이 생성·소멸되지 않고 두 판이 수평으로 어긋납니다.'
  },
  {
    title: '응력을 쌓아 지진 일으키기',
    desc: '보존형 경계를 유지하면서 응력을 85% 이상 쌓아 지진을 발생시켜 보세요.',
    hint: '↑   ↓',
    type: 'event',
    check: () => appState.boundary === 'TRANSFORM',
    success: '성공! 경계가 마찰로 고착되어 응력이 쌓이다가 한계를 넘으면 갑자기 미끄러지면서 지진이 발생합니다.'
  }
];

/* =========================================================================
   4) DOM
   ========================================================================= */
const $ = (id) => document.getElementById(id);

const els = {
  video: $('video'),
  camCanvas: $('cam-canvas'),
  camPlaceholder: $('cam-placeholder'),
  handStatus: $('hand-status'),
  handStatusText: $('hand-status-text'),
  legendA: $('legend-a'), legendB: $('legend-b'),
  manualHint: $('manual-hint'),
  debugBox: $('debug-box'), debugList: $('debug-list'),

  simCanvas: $('sim-canvas'),
  viewLabel: $('view-label'),
  boundaryBadge: $('boundary-badge'),
  quakeBadge: $('quake-badge'),
  simGuide: $('sim-guide'),

  outMotion: $('out-motion'), outBoundary: $('out-boundary'),
  outCompose: $('out-compose'), outLand: $('out-land'),
  outSpeed: $('out-speed'), outStressNum: $('out-stress-num'),
  stressFill: $('stress-fill'), stressGauge: $('stress-gauge'),
  outPhenomena: $('out-phenomena'),
  outQuake: $('out-quake'), outVolcano: $('out-volcano'),
  outCreate: $('out-create'), outConsume: $('out-consume'),
  outConcept: $('out-concept'), outExample: $('out-example'),
  recordBody: $('record-body'),

  missionCard: $('mission-card'), missionNo: $('mission-no'),
  missionTitle: $('mission-title'), missionDesc: $('mission-desc'),
  missionHint: $('mission-hint'), missionProgress: $('mission-progress'),
  missionProgressBar: $('mission-progress-bar'), missionState: $('mission-state')
};

const camCtx = els.camCanvas.getContext('2d');
const simCtx = els.simCanvas.getContext('2d');

/* =========================================================================
   5) 유틸
   ========================================================================= */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const now   = () => performance.now();

/** 값이 바뀔 때만 DOM 갱신 (매 프레임 전체 갱신 금지) */
function setText(el, value) {
  if (!el) return;
  const v = String(value);
  if (el._lastText === v) return;
  el._lastText = v;
  el.textContent = v;
}
function setStyle(el, prop, value) {
  if (!el) return;
  const key = '_st_' + prop;
  if (el[key] === value) return;
  el[key] = value;
  el.style[prop] = value;
}
function setHidden(el, hidden) {
  if (!el || el.hidden === hidden) return;
  el.hidden = hidden;
}
function setPressed(btn, on, labelOn, labelOff) {
  btn.setAttribute('aria-pressed', String(on));
  btn.classList.toggle('is-on', on);
  if (labelOn) setText(btn, on ? labelOn : labelOff);
}

/* =========================================================================
   6) 카메라 + MediaPipe
   ========================================================================= */
let handLandmarker = null;
let lastVideoTime = -1;
let latestResult = null;
let mpSource = '–';        // 손 인식 자산을 어디서 불러왔는지(디버그 표시용)

async function startCamera() {
  const btn = $('btn-camera');
  btn.disabled = true;
  setText(btn, '연결 중…');
  setStatus('LOADING');

  // 1) 카메라
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: CONFIG.camera.width, height: CONFIG.camera.height, facingMode: 'user' },
      audio: false
    });
    els.video.srcObject = stream;
    await els.video.play();
  } catch (err) {
    console.warn('camera error', err);
    btn.disabled = false;
    setText(btn, '카메라 시작');
    setStatus('CAMERA_DENIED');
    showError('카메라 사용 권한이 필요합니다. 브라우저 주소창의 카메라 권한을 허용한 뒤 다시 시도하세요.<br><br>' +
              '파일을 더블클릭해서 열었다면 <strong>localhost 서버</strong>나 https 주소로 열어야 카메라를 쓸 수 있습니다. (README 참고)');
    return;
  }

  // 2) MediaPipe 모델 (로컬 vendor/ 우선, 없으면 CDN)
  try {
    const src = await resolveMediaPipeAssets();
    mpSource = src.name;
    const vision = await import(/* @vite-ignore */ src.bundle);
    const fileset = await vision.FilesetResolver.forVisionTasks(src.wasm);
    try {
      handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: src.model, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2
      });
    } catch (gpuErr) {
      console.warn('GPU delegate 실패 → CPU로 재시도', gpuErr);
      handLandmarker = await vision.HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: src.model, delegate: 'CPU' },
        runningMode: 'VIDEO',
        numHands: 2
      });
    }
  } catch (err) {
    console.warn('mediapipe error', err);
    btn.disabled = false;
    setText(btn, '카메라 시작');
    setStatus('MODEL_FAIL');
    showError('손 인식 모델을 불러오지 못했습니다.<br><br>' +
              '<strong>vendor/</strong> 폴더가 함께 있으면 인터넷 없이도 동작합니다. ' +
              'vendor 폴더가 없다면 인터넷 연결을 확인한 뒤 새로고침해 주세요.<br><br>' +
              '그래도 안 되면 <strong>손 없이 조작</strong> 모드로 수업을 진행할 수 있습니다.');
    return;
  }

  appState.cameraRunning = true;
  els.camCanvas.width  = els.video.videoWidth  || CONFIG.camera.width;
  els.camCanvas.height = els.video.videoHeight || CONFIG.camera.height;
  setHidden(els.camPlaceholder, true);
  btn.disabled = false;
  setText(btn, '카메라 켜짐');
  btn.classList.remove('btn-primary');

  if (!localStorage.getItem('pml-tutorial-done')) openTutorial();
}

/* =========================================================================
   7) 손 좌표 · 히스토리 · 이동 벡터
   ========================================================================= */
const PALM_POINTS = [0, 5, 9, 13, 17];   // wrist + 각 손가락 MCP
const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17]
];

/**
 * MediaPipe raw 좌표 → 사용자 체감 좌표(mirror 적용).
 * ★ 좌우 반전은 반드시 이 함수 한 곳에서만 처리한다.
 */
const toUserX = (rawX) => 1 - rawX;

/** 손 랜드마크에서 손바닥 중심 + bounding box 크기를 뽑는다 */
function extractHandCenter(landmarks) {
  let cx = 0, cy = 0;
  for (const i of PALM_POINTS) {
    cx += toUserX(landmarks[i].x);
    cy += landmarks[i].y;
  }
  cx /= PALM_POINTS.length;
  cy /= PALM_POINTS.length;

  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const lm of landmarks) {
    const ux = toUserX(lm.x);
    minX = Math.min(minX, ux); maxX = Math.max(maxX, ux);
    minY = Math.min(minY, lm.y); maxY = Math.max(maxY, lm.y);
  }
  return { x: cx, y: cy, span: Math.max(maxX - minX, maxY - minY) };
}

/**
 * 판 A / 판 B 배정.
 * MediaPipe의 handedness 라벨은 손등이 보이거나 손이 회전하면 자주 뒤집히므로
 * 신뢰하지 않고 "화면상 x 좌표가 작은 쪽 = 판 A"로 고정한다.
 */
function assignHands(centers) {
  const sorted = [...centers].sort((p, q) => p.x - q.x);
  return { A: sorted[0], B: sorted[1] };
}

function pushHistory(key, pos, t) {
  const tr = tracks[key];
  const a = CONFIG.hand.smoothingAlpha;

  if (!tr.smooth) tr.smooth = { x: pos.x, y: pos.y };
  else {
    // 튀는 좌표 제한: 한 프레임에 정규화 0.25 이상 점프하면 무시
    const jump = Math.hypot(pos.x - tr.smooth.x, pos.y - tr.smooth.y);
    if (jump < 0.25) {
      tr.smooth.x = lerp(tr.smooth.x, pos.x, a);
      tr.smooth.y = lerp(tr.smooth.y, pos.y, a);
    }
  }

  tr.history.push({ x: tr.smooth.x, y: tr.smooth.y, t });
  const cutoff = t - CONFIG.hand.historyMs;
  while (tr.history.length && tr.history[0].t < cutoff) tr.history.shift();

  return { x: tr.smooth.x, y: tr.smooth.y, span: pos.span };
}

function avgWindow(history, t0, t1) {
  let sx = 0, sy = 0, st = 0, n = 0;
  for (const p of history) {
    if (p.t >= t0 && p.t <= t1) { sx += p.x; sy += p.y; st += p.t; n++; }
  }
  return n ? { x: sx / n, y: sy / n, t: st / n } : null;
}

/** 최근 평균 - 과거 평균 = 이동 벡터 */
function motionVector(key, t) {
  const h = tracks[key].history;
  const c = CONFIG.hand;
  const recent = avgWindow(h, t - c.recentWindowMs, t);
  const past   = avgWindow(h, t - c.pastWindowEndMs, t - c.pastWindowStartMs);
  if (!recent || !past) return null;
  return { x: recent.x - past.x, y: recent.y - past.y, dt: (recent.t - past.t) / 1000 };
}

function resetTracks() {
  tracks.A = { smooth: null, history: [] };
  tracks.B = { smooth: null, history: [] };
  appState.handA = appState.handB = null;
  appState.separation = appState.shear = appState.relSpeed = 0;
}

/* =========================================================================
   8) 경계 판별
   판 경계는 각 손의 절대 이동이 아니라 "두 손의 상대 운동"으로 판단한다.
   두 손을 잇는 축(경계축)을 기준으로 상대 이동 벡터를 분해하면
   손을 비스듬히 움직여도 안정적으로 판별된다.
   ========================================================================= */
function analyzeMotion(t) {
  const A = appState.handA, B = appState.handB;
  if (!A || !B) { appState.separation = appState.shear = appState.relSpeed = 0; return 'IDLE'; }

  // 경계축(A→B) — 두 손이 겹칠 만큼 가까우면 수평축으로 고정
  const dx = B.x - A.x, dy = B.y - A.y;
  const dist = Math.hypot(dx, dy);
  let ax = 1, ay = 0;
  if (dist > 0.06) { ax = dx / dist; ay = dy / dist; }
  appState.axis.x = lerp(appState.axis.x, ax, 0.15);
  appState.axis.y = lerp(appState.axis.y, ay, 0.15);
  const an = Math.hypot(appState.axis.x, appState.axis.y) || 1;
  const uax = appState.axis.x / an, uay = appState.axis.y / an;
  const upx = -uay, upy = uax;             // 경계축에 수직인 방향

  const vA = motionVector('A', t), vB = motionVector('B', t);
  if (!vA || !vB) return 'IDLE';

  // 상대 이동 벡터
  const rx = vB.x - vA.x, ry = vB.y - vA.y;
  appState.separation = rx * uax + ry * uay;   // + : 벌어짐 / - : 모임
  appState.shear      = rx * upx + ry * upy;   // 경계를 따라 엇갈리는 성분
  const dt = Math.max(vA.dt, 0.05);
  appState.relSpeed = Math.hypot(rx, ry) / dt;

  return classifyBoundary(appState.separation, appState.shear);
}

function classifyBoundary(sep, shear) {
  const c = CONFIG.hand;
  const aSep = Math.abs(sep), aSh = Math.abs(shear);

  if (aSep < c.separationThreshold * 0.55 && aSh < c.shearThreshold * 0.55) return 'IDLE';
  if (aSep >= c.separationThreshold && aSep > aSh * c.dominanceRatio) {
    return sep > 0 ? 'DIVERGENT' : 'CONVERGENT';
  }
  if (aSh >= c.shearThreshold && aSh > aSep * c.dominanceRatio) return 'TRANSFORM';
  return 'UNCERTAIN';
}

/** 후보 상태가 일정 시간 유지될 때만 실제 상태를 바꾼다(debounce) */
function debounceBoundary(candidate, t) {
  if (candidate !== appState.candidateBoundary) {
    appState.candidateBoundary = candidate;
    appState.candidateSince = t;
    return;
  }
  if (candidate !== appState.boundary && t - appState.candidateSince >= CONFIG.hand.stableStateMs) {
    appState.boundary = candidate;
    appState.boundarySince = t;
    // 발산 ↔ 수렴으로 성격이 바뀌면 판 변위를 중립에서 다시 시작한다
    if (candidate === 'DIVERGENT' && appState.plateOffset < 0) appState.plateOffset = 0;
    if (candidate === 'CONVERGENT' && appState.plateOffset > 0) appState.plateOffset = 0;
  }
}

/* =========================================================================
   9) 시뮬레이션 상태
   ========================================================================= */
function updateSimulation(dt) {
  const s = appState;
  const sepRate   = s.separation / 0.4;   // 약 400ms 창 → 초당 비율로 환산
  const shearRate = s.shear / 0.4;

  if (s.boundary === 'DIVERGENT') {
    const d = Math.max(0, sepRate) * CONFIG.sim.plateGain * dt;
    s.plateOffset = clamp(s.plateOffset + d, -1, 1);
    if (s.plateOffset > 0) s.crustCreated += d * 12;
  } else if (s.boundary === 'CONVERGENT') {
    const d = Math.max(0, -sepRate) * CONFIG.sim.plateGain * dt;
    s.plateOffset = clamp(s.plateOffset - d, -1, 1);
    const c = contentFor('CONVERGENT', s.convergenceType);
    if (c.consume) s.crustConsumed += d * 12;
  } else if (s.boundary === 'TRANSFORM') {
    if (Math.abs(shearRate) > 0.01) s.shearDir = Math.sign(shearRate) || s.shearDir;
    // 경계가 고착되어 있으므로 탄성 변형만 쌓인다 (미끄러짐은 지진 때 한 번에)
    s.elastic = clamp(s.elastic + Math.abs(shearRate) * CONFIG.sim.shearGain * dt, 0, CONFIG.sim.maxElastic);
  } else if (s.boundary === 'IDLE') {
    s.plateOffset += (0 - s.plateOffset) * CONFIG.sim.relaxRate * dt;
  }

  // ---- 응력 ----
  const building = (s.boundary === 'CONVERGENT' || s.boundary === 'TRANSFORM');
  if (building) {
    s.stress = clamp(s.stress + (CONFIG.stress.baseRate + s.relSpeed * CONFIG.stress.speedRate) * dt, 0, CONFIG.stress.max);
    if (s.stress >= CONFIG.stress.earthquakeThreshold) triggerEarthquake();
  } else {
    s.stress = clamp(s.stress - CONFIG.stress.decayRate * dt, 0, CONFIG.stress.max);
  }

  // ---- 지진 여파 ----
  s.shake = Math.max(0, s.shake - dt * 12);
  for (let i = s.quakeWaves.length - 1; i >= 0; i--) {
    const wv = s.quakeWaves[i];
    wv.r += wv.speed * dt;
    wv.life -= dt;
    if (wv.life <= 0) s.quakeWaves.splice(i, 1);
  }
}

function triggerEarthquake() {
  const s = appState;
  const t = now();
  if (t - s.lastQuakeAt < 700) return;   // 연속 발생 방지
  s.lastQuakeAt = t;
  s.stress = CONFIG.stress.postEarthquake;

  // 보존형: 쌓인 탄성 변형이 한 번에 미끄러짐으로 바뀐다
  if (s.boundary === 'TRANSFORM') {
    s.slip = clamp(s.slip + s.elastic * 0.75 * s.shearDir, -260, 260);
    s.elastic *= 0.25;
  }

  const ep = s.epicenter;
  for (let i = 0; i < 3; i++) {
    s.quakeWaves.push({ x: ep.x, y: ep.y, r: 6 + i * 14, speed: 150 + i * 20, life: 1.1, alpha: 0.55 });
  }
  s.shake = reduceMotion ? 0 : 3.5;
  s.quakeBadgeUntil = t + 1400;

  playQuakeSound();
  if (appState.mode === 'mission') onMissionEvent('earthquake');
}

/* =========================================================================
   10) 렌더링
   ========================================================================= */

// ---------- 10-1) 카메라 캔버스 ----------
function renderCamera() {
  const w = els.camCanvas.width, h = els.camCanvas.height;
  camCtx.clearRect(0, 0, w, h);

  if (appState.cameraRunning && els.video.readyState >= 2) {
    camCtx.save();
    camCtx.scale(-1, 1);                         // 시각적 mirror
    camCtx.drawImage(els.video, -w, 0, w, h);
    camCtx.restore();
  } else {
    camCtx.fillStyle = '#10151d';
    camCtx.fillRect(0, 0, w, h);
  }

  // 랜드마크(사용자 좌표계로 그리므로 mirror 재적용 불필요)
  if (appState.landmarkVisible && latestResult && latestResult.landmarks && !appState.manualMode) {
    for (const lms of latestResult.landmarks) {
      const cx = lms.reduce((a, p) => a + toUserX(p.x), 0) / lms.length;
      const color = (appState.handA && Math.abs(cx - appState.handA.x) < Math.abs(cx - (appState.handB?.x ?? 9)))
        ? '#5b9bf0' : '#f5a04a';

      camCtx.strokeStyle = color;
      camCtx.lineWidth = 2;
      for (const [a, b] of HAND_CONNECTIONS) {
        camCtx.beginPath();
        camCtx.moveTo(toUserX(lms[a].x) * w, lms[a].y * h);
        camCtx.lineTo(toUserX(lms[b].x) * w, lms[b].y * h);
        camCtx.stroke();
      }
      camCtx.fillStyle = color;
      for (const p of lms) {
        camCtx.beginPath();
        camCtx.arc(toUserX(p.x) * w, p.y * h, 3, 0, Math.PI * 2);
        camCtx.fill();
      }
    }
  }

  // 판 A / 판 B 마커
  drawPlateMarker(appState.handA, '판 A', '#2f6fd0', w, h, appState.manualMode && manualHands.selected === 'A');
  drawPlateMarker(appState.handB, '판 B', '#d97324', w, h, appState.manualMode && manualHands.selected === 'B');

  // 경계축 표시
  if (appState.handA && appState.handB) {
    camCtx.save();
    camCtx.setLineDash([6, 6]);
    camCtx.strokeStyle = 'rgba(255,255,255,.55)';
    camCtx.lineWidth = 2;
    camCtx.beginPath();
    camCtx.moveTo(appState.handA.x * w, appState.handA.y * h);
    camCtx.lineTo(appState.handB.x * w, appState.handB.y * h);
    camCtx.stroke();
    camCtx.restore();
  }
}

function drawPlateMarker(hand, label, color, w, h, selected) {
  if (!hand) return;
  const x = hand.x * w, y = hand.y * h;
  const r = appState.manualMode ? 26 : 16;

  camCtx.save();
  camCtx.globalAlpha = 0.85;
  camCtx.fillStyle = color;
  camCtx.beginPath(); camCtx.arc(x, y, r, 0, Math.PI * 2); camCtx.fill();
  camCtx.globalAlpha = 1;
  camCtx.lineWidth = selected ? 4 : 2;
  camCtx.strokeStyle = selected ? '#fff' : 'rgba(255,255,255,.7)';
  camCtx.stroke();

  camCtx.fillStyle = '#fff';
  camCtx.font = 'bold 13px sans-serif';
  camCtx.textAlign = 'center';
  camCtx.fillText(label, x, y - r - 8);
  camCtx.restore();
}

// ---------- 10-2) 시뮬레이션 캔버스 ----------
const COLORS = {
  sky:       '#e6f0fa',
  water:     '#a9d0ea',
  waterDeep: '#8cbcdd',
  astheno:   '#b8543a',
  mantle:    '#8a3218',
  mantleDeep:'#6b230f',
  plateA:    '#2f6fd0',
  plateAlt:  '#5b93de',
  plateB:    '#d97324',
  plateBlt:  '#e79a55',
  crustNew:  '#f5b73f',
  magma:     '#f2622a',
  magmaHot:  '#ffc061',
  ink:       '#22303f',
  landA:     '#7ea86a',
  landB:     '#c9a15f'
};

function resizeSimCanvas() {
  const rect = els.simCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(320, Math.round(rect.width));
  const h = Math.max(240, Math.round(rect.height));
  if (els.simCanvas.width !== w * dpr || els.simCanvas.height !== h * dpr) {
    els.simCanvas.width = w * dpr;
    els.simCanvas.height = h * dpr;
  }
  simCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function renderSimulation(t) {
  const { w, h } = resizeSimCanvas();
  const s = appState;

  simCtx.save();
  if (s.shake > 0.1) {
    simCtx.translate((Math.random() - 0.5) * s.shake * 2, (Math.random() - 0.5) * s.shake * 2);
  }

  if (s.boundary === 'TRANSFORM') renderTransform(w, h, t);
  else renderCrossSection(w, h, t);

  // 지진 파동
  for (const wv of s.quakeWaves) {
    simCtx.beginPath();
    simCtx.arc(wv.x, wv.y, wv.r, 0, Math.PI * 2);
    simCtx.strokeStyle = `rgba(200,40,20,${(wv.life / 1.1) * wv.alpha})`;
    simCtx.lineWidth = 3;
    simCtx.stroke();
  }
  simCtx.restore();
}

/* ---- 공통 배경(단면도) ---- */
function drawCrossBackdrop(w, h, g) {
  simCtx.fillStyle = COLORS.sky;      simCtx.fillRect(0, 0, w, g.seaY);
  simCtx.fillStyle = COLORS.water;    simCtx.fillRect(0, g.seaY, w, g.surfaceY - g.seaY);
  simCtx.fillStyle = COLORS.astheno;  simCtx.fillRect(0, g.surfaceY, w, g.mantleY - g.surfaceY);
  simCtx.fillStyle = COLORS.mantle;   simCtx.fillRect(0, g.mantleY, w, h - g.mantleY);

  // 맨틀 대류 힌트
  simCtx.save();
  simCtx.globalAlpha = 0.16;
  simCtx.strokeStyle = '#fff';
  simCtx.lineWidth = 2;
  for (let i = 0; i < 5; i++) {
    const x = (w / 5) * (i + 0.5);
    simCtx.beginPath();
    simCtx.arc(x, h - 6, 26, Math.PI * 1.15, Math.PI * 1.85);
    simCtx.stroke();
  }
  simCtx.restore();

  label(w - 8, g.seaY - 8, '해수면', 'right', 'rgba(40,70,100,.6)', 11);
  label(8, g.mantleY + 16, '맨틀', 'left', 'rgba(255,255,255,.72)', 12);
}

function label(x, y, text, align, color, size) {
  simCtx.save();
  simCtx.fillStyle = color || COLORS.ink;
  simCtx.font = `bold ${size || 12}px sans-serif`;
  simCtx.textAlign = align || 'left';
  simCtx.fillText(text, x, y);
  simCtx.restore();
}

function chipLabel(x, y, text, bg) {
  simCtx.save();
  simCtx.font = 'bold 11.5px sans-serif';
  const pad = 6, tw = simCtx.measureText(text).width;
  simCtx.fillStyle = bg;
  simCtx.beginPath();
  if (simCtx.roundRect) simCtx.roundRect(x - tw / 2 - pad, y - 13, tw + pad * 2, 19, 9);
  else simCtx.rect(x - tw / 2 - pad, y - 13, tw + pad * 2, 19);
  simCtx.fill();
  simCtx.fillStyle = '#fff';
  simCtx.textAlign = 'center';
  simCtx.fillText(text, x, y);
  simCtx.restore();
}

function arrow(x1, y1, x2, y2, color, width) {
  const ang = Math.atan2(y2 - y1, x2 - x1);
  simCtx.save();
  simCtx.strokeStyle = color; simCtx.fillStyle = color;
  simCtx.lineWidth = width || 3;
  simCtx.beginPath(); simCtx.moveTo(x1, y1); simCtx.lineTo(x2, y2); simCtx.stroke();
  simCtx.beginPath();
  simCtx.moveTo(x2, y2);
  simCtx.lineTo(x2 - Math.cos(ang - 0.4) * 11, y2 - Math.sin(ang - 0.4) * 11);
  simCtx.lineTo(x2 - Math.cos(ang + 0.4) * 11, y2 - Math.sin(ang + 0.4) * 11);
  simCtx.closePath(); simCtx.fill();
  simCtx.restore();
}

function quakeDot(x, y, t, phase, size) {
  const p = (Math.sin(t / 260 + phase) + 1) / 2;
  simCtx.save();
  simCtx.fillStyle = `rgba(210,40,25,${0.45 + p * 0.55})`;
  simCtx.beginPath(); simCtx.arc(x, y, (size || 4) * (0.8 + p * 0.4), 0, Math.PI * 2); simCtx.fill();
  simCtx.restore();
}

/* ---- 단면도: IDLE / UNCERTAIN / DIVERGENT / CONVERGENT ---- */
function renderCrossSection(w, h, t) {
  const g = { seaY: h * 0.28, surfaceY: h * 0.47, mantleY: h * 0.70, cx: w / 2 };
  drawCrossBackdrop(w, h, g);

  const s = appState;
  if (s.boundary === 'DIVERGENT') renderDivergent(w, h, g, t);
  else if (s.boundary === 'CONVERGENT') renderConvergent(w, h, g, t);
  else renderNeutral(w, h, g, t);
}

/* IDLE / UNCERTAIN — 맞닿은 두 판 */
function renderNeutral(w, h, g) {
  const th = 34;
  simCtx.fillStyle = COLORS.plateA;
  simCtx.fillRect(0, g.surfaceY, g.cx - 2, th);
  simCtx.fillStyle = COLORS.plateB;
  simCtx.fillRect(g.cx + 2, g.surfaceY, w - g.cx - 2, th);

  simCtx.strokeStyle = 'rgba(255,255,255,.85)';
  simCtx.setLineDash([5, 5]); simCtx.lineWidth = 2;
  simCtx.beginPath(); simCtx.moveTo(g.cx, g.surfaceY - 14); simCtx.lineTo(g.cx, g.surfaceY + th + 14); simCtx.stroke();
  simCtx.setLineDash([]);

  chipLabel(g.cx * 0.5, g.surfaceY + th + 26, '판 A', COLORS.plateA);
  chipLabel(g.cx + (w - g.cx) * 0.5, g.surfaceY + th + 26, '판 B', COLORS.plateB);
  label(g.cx, g.surfaceY - 26, '판 경계', 'center', 'rgba(40,70,100,.75)', 12);
  appState.epicenter = { x: g.cx, y: g.surfaceY + th / 2 };
}

/* 발산형 */
function renderDivergent(w, h, g, t) {
  const off = clamp(appState.plateOffset, 0, 1);
  const gap = 10 + off * Math.min(w * 0.18, 190);
  const th = 32, ridgeH = 30, flank = 120;
  const aR = g.cx - gap / 2, bL = g.cx + gap / 2;
  const newW = off * Math.min(w * 0.16, 160);

  // 상승하는 마그마 기둥
  const pulse = 1 + Math.sin(t / 420) * 0.12;
  const cw = Math.max(16, gap * 0.72) * pulse;
  const grad = simCtx.createLinearGradient(0, g.mantleY, 0, g.surfaceY - ridgeH);
  grad.addColorStop(0, COLORS.magma);
  grad.addColorStop(1, COLORS.magmaHot);
  simCtx.fillStyle = grad;
  simCtx.beginPath();
  simCtx.moveTo(g.cx - cw * 1.1, h);
  simCtx.lineTo(g.cx - cw / 2, g.surfaceY - ridgeH + 6);
  simCtx.lineTo(g.cx + cw / 2, g.surfaceY - ridgeH + 6);
  simCtx.lineTo(g.cx + cw * 1.1, h);
  simCtx.closePath(); simCtx.fill();

  // 상승 화살표
  for (let i = -1; i <= 1; i++) {
    const x = g.cx + i * 46;
    const y0 = g.mantleY + 34 + ((t / 14) % 40);
    arrow(x, y0, x, y0 - 32, 'rgba(255,220,180,.85)', 2.5);
  }

  // 판 A / 판 B (해령 쪽으로 융기하는 형태)
  drawRidgePlate(0, aR, th, ridgeH, flank, g.surfaceY, COLORS.plateA, +1, newW, COLORS.crustNew);
  drawRidgePlate(w, bL, th, ridgeH, flank, g.surfaceY, COLORS.plateB, -1, newW, COLORS.crustNew);

  // 새 지각 라벨
  if (newW > 22) {
    label(aR - newW / 2, g.surfaceY - ridgeH - 12, '새 지각', 'center', '#8a5a00', 11);
    label(bL + newW / 2, g.surfaceY - ridgeH - 12, '새 지각', 'center', '#8a5a00', 11);
  }

  // 열곡 / 해령 라벨
  chipLabel(g.cx, g.surfaceY - ridgeH - 26, '해령 · 열곡', '#b45309');
  arrow(aR - 60, g.surfaceY - ridgeH + th + 34, aR - 130, g.surfaceY - ridgeH + th + 34, COLORS.plateA, 3);
  arrow(bL + 60, g.surfaceY - ridgeH + th + 34, bL + 130, g.surfaceY - ridgeH + th + 34, COLORS.plateB, 3);
  chipLabel(Math.max(70, aR - 200), g.surfaceY + th + 24, '판 A', COLORS.plateA);
  chipLabel(Math.min(w - 70, bL + 200), g.surfaceY + th + 24, '판 B', COLORS.plateB);

  quakeDot(g.cx - 12, g.surfaceY + 6, t, 0, 3.5);
  quakeDot(g.cx + 14, g.surfaceY + 16, t, 2, 3.5);

  appState.epicenter = { x: g.cx, y: g.surfaceY };
}

/** 해령 쪽으로 융기하는 판 하나를 그린다. dir=+1이면 오른쪽 끝이 해령. */
function drawRidgePlate(outerX, ridgeX, th, ridgeH, flank, surfaceY, color, dir, newW, newColor) {
  const flankStart = ridgeX - dir * flank;
  simCtx.save();
  simCtx.beginPath();
  simCtx.moveTo(outerX, surfaceY);
  simCtx.lineTo(flankStart, surfaceY);
  simCtx.lineTo(ridgeX, surfaceY - ridgeH);
  simCtx.lineTo(ridgeX, surfaceY - ridgeH + th);
  simCtx.lineTo(flankStart, surfaceY + th);
  simCtx.lineTo(outerX, surfaceY + th);
  simCtx.closePath();
  simCtx.fillStyle = color;
  simCtx.fill();

  // 해령에 가까운 부분 = 새로 만들어진 지각
  if (newW > 4) {
    simCtx.clip();
    simCtx.fillStyle = newColor;
    const x0 = dir > 0 ? ridgeX - newW : ridgeX;
    simCtx.fillRect(x0, surfaceY - ridgeH - 4, newW, th + ridgeH + 12);
  }
  simCtx.restore();
}

/* 수렴형 */
function renderConvergent(w, h, g, t) {
  const comp = clamp(-appState.plateOffset, 0, 1);
  const type = appState.convergenceType;
  if (type === 'continental-continental') renderCollision(w, h, g, t, comp);
  else renderSubduction(w, h, g, t, comp, type);
}

function renderSubduction(w, h, g, t, comp, type) {
  const oceanContinent = (type === 'oceanic-continental');
  const oTh = 28;
  const contactX = g.cx - 40;
  const trenchDepth = oceanContinent ? 34 : 44;

  // --- 섭입하는 해양판(판 A) ---
  simCtx.fillStyle = COLORS.plateA;
  simCtx.beginPath();
  simCtx.moveTo(0, g.surfaceY);
  simCtx.lineTo(contactX - 110, g.surfaceY);
  simCtx.lineTo(contactX, g.surfaceY + trenchDepth);
  simCtx.lineTo(contactX, g.surfaceY + trenchDepth + oTh);
  simCtx.lineTo(contactX - 110, g.surfaceY + oTh);
  simCtx.lineTo(0, g.surfaceY + oTh);
  simCtx.closePath(); simCtx.fill();

  // --- 섭입 슬랩 ---
  const ang = 42 * Math.PI / 180;
  const dx = Math.cos(ang), dy = Math.sin(ang);
  const L = 80 + comp * 190;
  const sx = contactX, sy = g.surfaceY + trenchDepth;
  const px = -dy, py = dx;
  simCtx.fillStyle = COLORS.plateAlt;
  simCtx.beginPath();
  simCtx.moveTo(sx, sy);
  simCtx.lineTo(sx + dx * L, sy + dy * L);
  simCtx.lineTo(sx + dx * L + px * oTh, sy + dy * L + py * oTh);
  simCtx.lineTo(sx + px * oTh, sy + py * oTh);
  simCtx.closePath(); simCtx.fill();

  // 베니오프대 지진 (얕은 곳 → 깊은 곳)
  for (let i = 1; i <= 4; i++) {
    const f = i / 5;
    if (f * L > L * 0.05) {
      quakeDot(sx + dx * L * f + px * oTh * 0.5, sy + dy * L * f + py * oTh * 0.5, t, i * 1.3, 4.5);
    }
  }

  // --- 위쪽 판(판 B) ---
  const vx = clamp(contactX + 150, 120, w - 90);
  if (oceanContinent) {
    const cTh = 66;
    const landTop = g.surfaceY - (24 + comp * 16);
    simCtx.fillStyle = COLORS.plateB;
    simCtx.beginPath();
    simCtx.moveTo(contactX, g.surfaceY + trenchDepth);
    simCtx.lineTo(contactX + 80, landTop);
    simCtx.lineTo(w, landTop);
    simCtx.lineTo(w, landTop + cTh);
    simCtx.lineTo(contactX + 60, landTop + cTh);
    simCtx.closePath(); simCtx.fill();
    // 육지 표면
    simCtx.fillStyle = COLORS.landB;
    simCtx.beginPath();
    simCtx.moveTo(contactX + 80, landTop);
    simCtx.lineTo(w, landTop);
    simCtx.lineTo(w, landTop + 9);
    simCtx.lineTo(contactX + 82, landTop + 9);
    simCtx.closePath(); simCtx.fill();

    drawMagmaAndVolcano(vx, landTop, sx + dx * L * 0.62, sy + dy * L * 0.62, comp, t, false);
    chipLabel(Math.min(w - 60, vx + 130), landTop - 8, '대륙판(판 B)', COLORS.plateB);
  } else {
    const cTh = 30;
    simCtx.fillStyle = COLORS.plateB;
    simCtx.beginPath();
    simCtx.moveTo(contactX, g.surfaceY + trenchDepth);
    simCtx.lineTo(contactX + 70, g.surfaceY);
    simCtx.lineTo(w, g.surfaceY);
    simCtx.lineTo(w, g.surfaceY + cTh);
    simCtx.lineTo(contactX + 50, g.surfaceY + cTh);
    simCtx.closePath(); simCtx.fill();

    drawMagmaAndVolcano(vx, g.surfaceY, sx + dx * L * 0.62, sy + dy * L * 0.62, comp, t, true, g.seaY);
    chipLabel(Math.min(w - 60, vx + 130), g.surfaceY + 46, '해양판(판 B)', COLORS.plateB);
  }

  // 해구
  chipLabel(contactX - 46, g.surfaceY + trenchDepth + 44, '해구', '#0f4c75');
  arrow(contactX - 60, g.surfaceY + trenchDepth + 62, contactX - 20, g.surfaceY + trenchDepth + 50, '#0f4c75', 2);

  chipLabel(Math.max(66, contactX - 240), g.surfaceY + oTh + 26, '해양판(판 A)', COLORS.plateA);
  arrow(90, g.surfaceY - 26, 190, g.surfaceY - 26, COLORS.plateA, 3);
  arrow(w - 90, g.surfaceY - 60, w - 190, g.surfaceY - 60, COLORS.plateB, 3);
  label(contactX + 12, g.surfaceY + trenchDepth + 96, '섭입', 'left', '#fff', 12);

  appState.epicenter = { x: sx + dx * L * 0.4, y: sy + dy * L * 0.4 };
}

function drawMagmaAndVolcano(vx, baseY, mx, my, comp, t, island, seaY) {
  // 마그마 상승 경로
  simCtx.save();
  simCtx.globalAlpha = 0.9;
  for (let i = 0; i < 4; i++) {
    const f = ((t / 1300 + i * 0.25) % 1);
    const x = lerp(mx, vx, f) + Math.sin(t / 300 + i) * 4;
    const y = lerp(my, baseY + 8, f);
    const r = 9 - f * 3;
    simCtx.fillStyle = f < 0.6 ? COLORS.magma : COLORS.magmaHot;
    simCtx.beginPath(); simCtx.arc(x, y, r, 0, Math.PI * 2); simCtx.fill();
  }
  simCtx.restore();

  // 화산체
  const vh = (island ? 60 : 44) + comp * 28;
  const halfW = 52 + comp * 12;
  const peakY = baseY - vh;
  simCtx.fillStyle = '#5a4636';
  simCtx.beginPath();
  simCtx.moveTo(vx - halfW, baseY + 4);
  simCtx.lineTo(vx - 8, peakY);
  simCtx.lineTo(vx + 8, peakY);
  simCtx.lineTo(vx + halfW, baseY + 4);
  simCtx.closePath(); simCtx.fill();

  // 분출
  if (comp > 0.18) {
    const burst = (Math.sin(t / 700) + 1) / 2;
    simCtx.save();
    simCtx.globalAlpha = 0.55 + burst * 0.45;
    simCtx.fillStyle = COLORS.magma;
    simCtx.beginPath();
    simCtx.moveTo(vx - 9, peakY + 2);
    simCtx.lineTo(vx, peakY - 14 - burst * 22);
    simCtx.lineTo(vx + 9, peakY + 2);
    simCtx.closePath(); simCtx.fill();
    for (let i = 0; i < 5; i++) {
      const a = (t / 400 + i) % 1;
      simCtx.globalAlpha = (1 - a) * 0.8;
      simCtx.beginPath();
      simCtx.arc(vx + Math.sin(i * 2.2) * 26 * a, peakY - 10 - a * 44, 4 - a * 2, 0, Math.PI * 2);
      simCtx.fill();
    }
    simCtx.restore();
  }
  chipLabel(vx, peakY - 30, island ? '화산섬(호상 열도)' : '화산', '#b3341f');
}

/* 대륙 – 대륙 충돌 */
function renderCollision(w, h, g, t, comp) {
  const cTh = 66;
  const top = g.surfaceY - 24;
  const cx = g.cx;
  const rootDepth = 26 + comp * 74;
  const mtnH = 16 + comp * 116;
  const mtnW = 84 + comp * 92;

  // 두 대륙판 (뿌리가 아래로 두꺼워짐)
  const drawContinent = (fromX, toX, color, sign) => {
    simCtx.fillStyle = color;
    simCtx.beginPath();
    simCtx.moveTo(fromX, top);
    simCtx.lineTo(toX, top);
    simCtx.lineTo(toX, top + cTh);
    simCtx.quadraticCurveTo(cx + sign * mtnW * 0.4, top + cTh + rootDepth, cx, top + cTh + rootDepth);
    simCtx.lineTo(cx, top + cTh + rootDepth);
    simCtx.lineTo(fromX, top + cTh);
    simCtx.closePath(); simCtx.fill();
  };
  drawContinent(0, cx, COLORS.plateA, -1);
  drawContinent(w, cx, COLORS.plateB, 1);

  // 습곡 산맥 — 겹치는 삼각 봉우리
  const peaks = 5;
  for (let i = 0; i < peaks; i++) {
    const f = (i / (peaks - 1)) - 0.5;               // -0.5 ~ 0.5
    const px = cx + f * mtnW * 1.6;
    const ph = mtnH * (1 - Math.abs(f) * 1.1);
    if (ph <= 4) continue;
    simCtx.fillStyle = i % 2 ? COLORS.plateAlt : COLORS.plateBlt;
    simCtx.beginPath();
    simCtx.moveTo(px - 46, top + 2);
    simCtx.lineTo(px, top - ph);
    simCtx.lineTo(px + 46, top + 2);
    simCtx.closePath(); simCtx.fill();
    if (ph > 46) { // 만년설
      simCtx.fillStyle = '#f4f8fc';
      simCtx.beginPath();
      simCtx.moveTo(px - 13, top - ph + 27);
      simCtx.lineTo(px, top - ph);
      simCtx.lineTo(px + 13, top - ph + 27);
      simCtx.closePath(); simCtx.fill();
    }
  }

  // 습곡(휘어진 지층) 표시
  simCtx.save();
  simCtx.strokeStyle = 'rgba(255,255,255,.5)';
  simCtx.lineWidth = 2;
  for (let i = 1; i <= 3; i++) {
    const y = top + 16 * i + 8;
    simCtx.beginPath();
    for (let x = cx - mtnW * 1.4; x <= cx + mtnW * 1.4; x += 6) {
      const d = (x - cx) / (mtnW * 0.6);
      const yy = y - Math.cos(d * 2.2) * 9 * comp;
      x === cx - mtnW * 1.4 ? simCtx.moveTo(x, yy) : simCtx.lineTo(x, yy);
    }
    simCtx.stroke();
  }
  simCtx.restore();

  quakeDot(cx - 34, top + 40, t, 0, 5);
  quakeDot(cx + 30, top + 58, t, 1.8, 5);

  chipLabel(cx, top - mtnH - 26, '습곡 산맥', '#5a3a1a');
  chipLabel(Math.max(70, cx - 240), top + cTh + 40, '대륙판(판 A)', COLORS.plateA);
  chipLabel(Math.min(w - 70, cx + 240), top + cTh + 40, '대륙판(판 B)', COLORS.plateB);
  arrow(90, top - 30, 190, top - 30, COLORS.plateA, 3);
  arrow(w - 90, top - 30, w - 190, top - 30, COLORS.plateB, 3);
  label(cx, top + cTh + rootDepth + 22, '지각이 두꺼워짐', 'center', 'rgba(255,255,255,.85)', 11.5);

  appState.epicenter = { x: cx, y: top + 40 };
}

/* ---- 평면도: 보존형 경계 ----
   단면도로는 "스쳐 지나감"을 보여줄 수 없으므로 위에서 본 모습으로 전환한다. */
function renderTransform(w, h, t) {
  const s = appState;
  const cx = w / 2;
  const S = 95;                              // 탄성 변형이 퍼지는 거리 척도
  const half = (d) => (s.slip + s.elastic * s.shearDir * (1 - Math.exp(-d / S))) / 2;

  // 배경
  simCtx.fillStyle = '#dfe8d9'; simCtx.fillRect(0, 0, cx, h);
  simCtx.fillStyle = '#efe4d2'; simCtx.fillRect(cx, 0, w - cx, h);

  // 지형선 (변형이 보이도록 여러 줄)
  const drawLine = (baseY, color, width, dashed) => {
    simCtx.save();
    simCtx.strokeStyle = color; simCtx.lineWidth = width;
    if (dashed) simCtx.setLineDash([7, 6]);
    simCtx.beginPath();
    for (let x = 0; x <= cx; x += 5) {
      const y = baseY - half(cx - x);
      x === 0 ? simCtx.moveTo(x, y) : simCtx.lineTo(x, y);
    }
    simCtx.stroke();
    simCtx.beginPath();
    for (let x = cx; x <= w; x += 5) {
      const y = baseY + half(x - cx);
      x === cx ? simCtx.moveTo(x, y) : simCtx.lineTo(x, y);
    }
    simCtx.stroke();
    simCtx.restore();
  };

  for (let i = 1; i <= 6; i++) drawLine(h * i / 7, 'rgba(90,110,90,.28)', 1.5, true);

  // 단층을 가로지르는 하천 — 어긋남이 한눈에 보이는 기준선
  drawLine(h * 0.5, '#2f7fb8', 5, false);
  label(24, h * 0.5 - 12, '하천(기준선)', 'left', '#1c5c86', 11.5);

  // 단층선 (응력에 따라 색 변화)
  const st = s.stress / 100;
  const faultColor = st > 0.75 ? '#c2331f' : st > 0.45 ? '#c98a10' : '#3f7a52';
  simCtx.save();
  simCtx.strokeStyle = faultColor;
  simCtx.lineWidth = 5;
  simCtx.beginPath(); simCtx.moveTo(cx, 0); simCtx.lineTo(cx, h); simCtx.stroke();
  simCtx.restore();

  // 이동 방향 화살표
  const dir = s.shearDir || 1;
  arrow(cx - 90, h * 0.22 + 30 * dir, cx - 90, h * 0.22 - 30 * dir, COLORS.plateA, 4);
  arrow(cx + 90, h * 0.22 - 30 * dir, cx + 90, h * 0.22 + 30 * dir, COLORS.plateB, 4);

  chipLabel(cx * 0.45, h * 0.10, '판 A', COLORS.plateA);
  chipLabel(cx + (w - cx) * 0.55, h * 0.10, '판 B', COLORS.plateB);
  chipLabel(cx, h - 18, s.stress > CONFIG.stress.earthquakeThreshold - 15 ? '단층 고착 · 응력 한계 근접' : '변환 단층(경계면)', faultColor);

  // 고착 구간 표시
  if (s.elastic > 8) {
    simCtx.save();
    simCtx.globalAlpha = 0.18 + st * 0.25;
    simCtx.fillStyle = faultColor;
    simCtx.fillRect(cx - 46, 0, 92, h);
    simCtx.restore();
    label(cx, h * 0.78, '고착(마찰로 잠김) 구간', 'center', faultColor, 11.5);
  }

  label(w - 14, h - 14, '위에서 본 모습', 'right', 'rgba(60,70,60,.6)', 11);
  s.epicenter = { x: cx, y: h * 0.5 };
}

/* =========================================================================
   11) 정보 패널
   ========================================================================= */
function updateInfoPanel() {
  const s = appState;
  const c = contentFor(s.boundary, s.convergenceType);

  setText(els.outMotion, c.motion);
  setText(els.outBoundary, c.boundary);
  setText(els.outCompose, s.boundary === 'CONVERGENT' ? CONV_LABEL[s.convergenceType] : '–');
  setText(els.outLand, c.land);
  setText(els.outQuake, c.quake);
  setText(els.outVolcano, c.volcano);
  setText(els.outCreate, c.create && s.crustCreated > 1 ? `있음 (모의 ${Math.round(s.crustCreated)})` : (c.create ? '있음' : '없음'));
  setText(els.outConsume, c.consume && s.crustConsumed > 1 ? `있음 (모의 ${Math.round(s.crustConsumed)})` : (c.consume ? '있음' : '없음'));
  setText(els.outConcept, c.concept);
  setText(els.outExample, c.example);

  // 현상 목록 — 내용이 바뀔 때만 다시 그린다
  const key = c.phenomena.join('|');
  if (els.outPhenomena._key !== key) {
    els.outPhenomena._key = key;
    els.outPhenomena.innerHTML = c.phenomena.map(p => `<li>${p}</li>`).join('');
  }

  // 배지
  if (els.boundaryBadge._key !== c.badge) {
    els.boundaryBadge._key = c.badge;
    els.boundaryBadge.textContent = c.badge;
    els.boundaryBadge.className = 'badge ' + c.badgeClass;
  }
  setText(els.viewLabel, s.boundary === 'TRANSFORM' ? '평면도 (위에서 본 모습)' : '단면도 (옆에서 자른 모습)');

  // 속도
  let speedLabel = '정지';
  if (s.handA && s.handB) {
    if (s.relSpeed >= CONFIG.speed.fast) speedLabel = '빠름';
    else if (s.relSpeed >= CONFIG.speed.slow) speedLabel = '보통';
    else speedLabel = '느림';
  }
  setText(els.outSpeed, `시뮬레이션 ${speedLabel}`);

  // 응력
  const pct = Math.round(s.stress);
  setText(els.outStressNum, pct + '%');
  setStyle(els.stressFill, 'width', pct + '%');
  setStyle(els.stressFill, 'background', pct >= 85 ? '#c2331f' : pct >= 50 ? '#d99a12' : '#1f7a4d');
  els.stressGauge.setAttribute('aria-valuenow', String(pct));

  // 지진 배지
  setHidden(els.quakeBadge, now() > s.quakeBadgeUntil);

  // 시뮬레이션 안내 문구
  let guide = '';
  if (!s.cameraRunning && !s.manualMode) guide = '카메라를 시작하거나 “손 없이 조작”을 켜 주세요.';
  else if (s.handsDetected < 2) guide = '두 손을 모두 카메라에 보여 주세요.';
  else if (s.boundary === 'IDLE') guide = '두 판의 상대 운동을 만들어 보세요. (벌리기 / 모으기 / 엇갈리기)';
  else if (s.boundary === 'UNCERTAIN') guide = '판 운동을 더 크고 분명하게 보여 주세요.';
  setHidden(els.simGuide, guide === '');
  if (guide) setText(els.simGuide, guide);

  setText(els.legendA, s.handA ? '인식됨' : '–');
  setText(els.legendB, s.handB ? '인식됨' : '–');

  if (s.debugVisible) updateDebug();
}

const STATUS_TEXT = {
  IDLE_CAMERA:    ['status-wait', '대기 중 — 카메라가 꺼져 있습니다.'],
  LOADING:        ['status-wait', '카메라와 손 인식 모델을 불러오는 중…'],
  MANUAL:         ['status-ok',   '손 없이 조작 모드 — 두 원을 움직여 보세요.'],
  TRACKING:       ['status-ok',   '두 손 인식 중 — 판 A와 판 B가 준비되었습니다.'],
  ONE_HAND:       ['status-wait', '두 손을 모두 카메라에 보여 주세요.'],
  NO_HAND:        ['status-wait', '손이 보이지 않습니다. 카메라 앞에 두 손을 들어 주세요.'],
  TOO_SMALL:      ['status-wait', '손을 카메라에 조금 더 가까이 보여 주세요.'],
  OUT_OF_FRAME:   ['status-wait', '두 손 전체가 화면 안에 들어오도록 해 주세요.'],
  CAMERA_DENIED:  ['status-err',  '카메라 권한이 거부되었습니다.'],
  MODEL_FAIL:     ['status-err',  '손 인식 모델을 불러오지 못했습니다.']
};

function setStatus(key) {
  if (appState.handStatus === key) return;
  appState.handStatus = key;
  const [cls, text] = STATUS_TEXT[key] || STATUS_TEXT.IDLE_CAMERA;
  els.handStatus.className = 'status ' + cls;
  setText(els.handStatusText, text);
}

function updateDebug() {
  const s = appState;
  const rows = [
    ['hands', s.handsDetected],
    ['boundary', s.boundary],
    ['candidate', s.candidateBoundary],
    ['separation', s.separation.toFixed(4)],
    ['shear', s.shear.toFixed(4)],
    ['relSpeed', s.relSpeed.toFixed(3)],
    ['offset', s.plateOffset.toFixed(3)],
    ['stress', s.stress.toFixed(1)],
    ['elastic', s.elastic.toFixed(1)],
    ['slip', s.slip.toFixed(1)],
    ['fps', fpsDisplay.toFixed(0)],
    ['assets', mpSource]
  ];
  const html = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  if (els.debugList._key !== html) { els.debugList._key = html; els.debugList.innerHTML = html; }
}

/* =========================================================================
   12) 미션 · 튜토리얼 · 모달
   ========================================================================= */
function startMissionMode() {
  appState.mode = 'mission';
  appState.missionIndex = 0;
  appState.missionHold = 0;
  setHidden(els.missionCard, false);
  $('btn-mission').classList.add('is-active');
  $('btn-mission').setAttribute('aria-pressed', 'true');
  $('btn-free').classList.remove('is-active');
  $('btn-free').setAttribute('aria-pressed', 'false');
  loadMission(0);
}

function startFreeMode() {
  appState.mode = 'free';
  appState.missionActive = false;
  setHidden(els.missionCard, true);
  $('btn-free').classList.add('is-active');
  $('btn-free').setAttribute('aria-pressed', 'true');
  $('btn-mission').classList.remove('is-active');
  $('btn-mission').setAttribute('aria-pressed', 'false');
}

function loadMission(i) {
  if (i >= MISSIONS.length) {
    showSuccess('모든 미션 완료!', '5개의 미션을 모두 성공했습니다. 자유 탐구 모드에서 더 실험해 보세요.', null, true);
    startFreeMode();
    return;
  }
  const m = MISSIONS[i];
  appState.missionIndex = i;
  appState.missionHold = 0;
  appState.missionActive = false;
  appState.quizAnswer = null;

  setText(els.missionNo, String(i + 1));
  setText(els.missionTitle, m.title);
  setText(els.missionDesc, m.desc);
  setText(els.missionHint, m.hint);
  setText(els.missionState, m.type === 'event' ? '응력을 쌓아 지진을 일으키세요.' : '조건을 만들어 1초 이상 유지하세요.');
  setStyle(els.missionProgress, 'width', '0%');

  // 사전 설정 / 학생 선택
  if (m.preset) {
    appState.convergenceType = m.preset;
    document.querySelector(`input[name="convtype"][value="${m.preset}"]`).checked = true;
  }
  appState.stress = 0;
  appState.elastic = 0;

  if (m.quiz) openQuiz(m.quiz);
  else appState.missionActive = true;
}

function updateMission(dt) {
  if (appState.mode !== 'mission' || !appState.missionActive) return;
  const m = MISSIONS[appState.missionIndex];
  if (!m) return;

  if (m.type === 'hold') {
    if (m.check()) {
      appState.missionHold += dt * 1000;
      const p = clamp(appState.missionHold / CONFIG.mission.successHoldMs, 0, 1);
      setStyle(els.missionProgress, 'width', (p * 100).toFixed(0) + '%');
      els.missionProgressBar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
      setText(els.missionState, p >= 1 ? '성공!' : '유지하는 중…');
      if (p >= 1) succeedMission();
    } else {
      appState.missionHold = Math.max(0, appState.missionHold - dt * 1200);
      setStyle(els.missionProgress, 'width', (appState.missionHold / CONFIG.mission.successHoldMs * 100).toFixed(0) + '%');
      setText(els.missionState, '조건을 만들어 1초 이상 유지하세요.');
    }
  } else if (m.type === 'event') {
    const ok = m.check();
    setText(els.missionState, ok ? `응력을 쌓는 중… ${Math.round(appState.stress)}%` : '먼저 보존형 경계를 만드세요.');
    setStyle(els.missionProgress, 'width', (ok ? appState.stress : 0) + '%');
  }
}

function onMissionEvent(type) {
  if (appState.mode !== 'mission' || !appState.missionActive) return;
  const m = MISSIONS[appState.missionIndex];
  if (m && m.type === 'event' && type === 'earthquake' && m.check()) succeedMission();
}

function succeedMission() {
  const m = MISSIONS[appState.missionIndex];
  appState.missionActive = false;
  playSuccessSound();
  const review = (m.quiz && appState.quizAnswer !== null) ? m.quiz.review : null;
  showSuccess(`미션 ${appState.missionIndex + 1} 성공!`, m.success, review, false);
}

function showSuccess(title, body, review, isFinal) {
  setText($('success-title'), title);
  setText($('success-body'), body);
  setHidden($('success-review'), !review);
  if (review) setText($('success-review-text'), review);
  setText($('btn-success-next'), isFinal ? '닫기' : '다음 미션');
  $('btn-success-next').dataset.final = isFinal ? '1' : '';
  setHidden($('success-modal'), false);
}

/* --- 예측 질문 --- */
function openQuiz(quiz) {
  setText($('quiz-title'), quiz.q);
  const box = $('quiz-options');
  box.innerHTML = '';
  quiz.options.forEach((opt, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quiz-option';
    b.textContent = `${'ABC'[i]}. ${opt}`;
    b.addEventListener('click', () => {
      [...box.children].forEach(c => c.classList.remove('is-picked'));
      b.classList.add('is-picked');
      appState.quizAnswer = i;
      $('btn-quiz-go').disabled = false;
    });
    box.appendChild(b);
  });
  $('btn-quiz-go').disabled = true;
  setHidden($('quiz-modal'), false);
}

/* --- 튜토리얼 --- */
const TUTORIAL = [
  { title: '두 손을 카메라에 보여 주세요.', glyph: '✋   ✋', body: '화면 왼쪽 손이 판 A, 오른쪽 손이 판 B가 됩니다. 두 손이 모두 보여야 판 운동을 판별합니다.' },
  { title: '손을 양쪽으로 벌려 보세요.', glyph: '←      →', body: '두 판이 멀어지는 발산형 경계입니다. 해령이 만들어지고 새로운 지각이 생성됩니다.' },
  { title: '손을 서로 가까이 모아 보세요.', glyph: '→      ←', body: '두 판이 가까워지는 수렴형 경계입니다. 만나는 판의 종류에 따라 결과가 달라집니다.' },
  { title: '두 손을 위아래로 엇갈리게 움직여 보세요.', glyph: '↑      ↓', body: '두 판이 스쳐 지나가는 보존형 경계입니다. 응력이 쌓이다가 지진이 발생합니다.' }
];
let tutStep = 0;

function openTutorial() {
  tutStep = 0;
  renderTutorial();
  setHidden($('tutorial-modal'), false);
}
function renderTutorial() {
  const s = TUTORIAL[tutStep];
  setText($('tut-step'), String(tutStep + 1));
  setText($('tut-title'), s.title);
  setText($('tut-glyph'), s.glyph);
  setText($('tut-body'), s.body);
  setText($('btn-tut-next'), tutStep === TUTORIAL.length - 1 ? '시작하기' : '다음');
}
function closeTutorial() {
  setHidden($('tutorial-modal'), true);
  localStorage.setItem('pml-tutorial-done', '1');
}

function showError(html) {
  $('error-body').innerHTML = html;
  setHidden($('error-modal'), false);
}

/* =========================================================================
   13) 수동 조작 모드 · 사운드
   ========================================================================= */
function setManualMode(on) {
  appState.manualMode = on;
  setPressed($('btn-manual'), on, '손 없이 조작: ON', '손 없이 조작: OFF');
  setHidden(els.manualHint, !on);
  resetTracks();
  if (on) {
    manualHands.A = { x: 0.32, y: 0.5 };
    manualHands.B = { x: 0.68, y: 0.5 };
    setHidden(els.camPlaceholder, true);
    if (!appState.cameraRunning) {
      els.camCanvas.width = CONFIG.camera.width;
      els.camCanvas.height = CONFIG.camera.height;
    }
    setStatus('MANUAL');
    els.camCanvas.focus();
  } else if (!appState.cameraRunning) {
    setHidden(els.camPlaceholder, false);
    setStatus('IDLE_CAMERA');
  }
}

function canvasPointToNorm(e) {
  const r = els.camCanvas.getBoundingClientRect();
  return { x: clamp((e.clientX - r.left) / r.width, 0.03, 0.97), y: clamp((e.clientY - r.top) / r.height, 0.05, 0.95) };
}

function bindManualControls() {
  const cv = els.camCanvas;
  cv.tabIndex = 0;

  cv.addEventListener('pointerdown', (e) => {
    if (!appState.manualMode) return;
    const p = canvasPointToNorm(e);
    const dA = Math.hypot(p.x - manualHands.A.x, p.y - manualHands.A.y);
    const dB = Math.hypot(p.x - manualHands.B.x, p.y - manualHands.B.y);
    const key = dA < dB ? 'A' : 'B';
    manualHands.selected = key;
    manualHands.dragging = key;
    cv.setPointerCapture(e.pointerId);
    cv.focus();
  });

  cv.addEventListener('pointermove', (e) => {
    if (!appState.manualMode || !manualHands.dragging) return;
    const p = canvasPointToNorm(e);
    manualHands[manualHands.dragging].x = p.x;
    manualHands[manualHands.dragging].y = p.y;
  });

  const endDrag = () => { manualHands.dragging = null; };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  cv.addEventListener('keydown', (e) => {
    if (!appState.manualMode) return;
    if (e.key === '1') { manualHands.selected = 'A'; e.preventDefault(); return; }
    if (e.key === '2') { manualHands.selected = 'B'; e.preventDefault(); return; }
    const step = e.shiftKey ? 0.035 : 0.014;
    const h = manualHands[manualHands.selected];
    if (e.key === 'ArrowLeft')  { h.x = clamp(h.x - step, 0.03, 0.97); e.preventDefault(); }
    if (e.key === 'ArrowRight') { h.x = clamp(h.x + step, 0.03, 0.97); e.preventDefault(); }
    if (e.key === 'ArrowUp')    { h.y = clamp(h.y - step, 0.05, 0.95); e.preventDefault(); }
    if (e.key === 'ArrowDown')  { h.y = clamp(h.y + step, 0.05, 0.95); e.preventDefault(); }
  });
}

/* --- 사운드 --- */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function playQuakeSound() {
  if (!appState.soundEnabled) return;
  const ac = ensureAudio();
  const dur = 0.9;
  const buf = ac.createBuffer(1, ac.sampleRate * dur, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const env = Math.pow(1 - i / data.length, 2);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ac.createBufferSource(); src.buffer = buf;
  const flt = ac.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = 220;
  const gain = ac.createGain(); gain.gain.value = 0.35;
  src.connect(flt).connect(gain).connect(ac.destination);
  src.start();
}
function playSuccessSound() {
  if (!appState.soundEnabled) return;
  const ac = ensureAudio();
  [523.25, 659.25, 783.99].forEach((f, i) => {
    const o = ac.createOscillator(); const g = ac.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.09);
    g.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + i * 0.09 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.09 + 0.28);
    o.connect(g).connect(ac.destination);
    o.start(ac.currentTime + i * 0.09);
    o.stop(ac.currentTime + i * 0.09 + 0.3);
  });
}

/* =========================================================================
   14) 메인 루프
   ========================================================================= */
let lastFrameTime = now();
let fpsDisplay = 0;

function processHands(t) {
  // --- 수동 모드 ---
  if (appState.manualMode) {
    appState.handsDetected = 2;
    appState.handA = pushHistory('A', { ...manualHands.A, span: 0.3 }, t);
    appState.handB = pushHistory('B', { ...manualHands.B, span: 0.3 }, t);
    appState.lastSeenAt = t;
    setStatus('MANUAL');
    return;
  }

  if (!appState.cameraRunning) { appState.handsDetected = 0; return; }

  // --- MediaPipe 추론 (새 비디오 프레임일 때만) ---
  if (handLandmarker && els.video.readyState >= 2 && els.video.currentTime !== lastVideoTime) {
    lastVideoTime = els.video.currentTime;
    try { latestResult = handLandmarker.detectForVideo(els.video, t); }
    catch (err) { console.warn('detect error', err); }
  }

  const lms = latestResult?.landmarks || [];
  appState.handsDetected = lms.length;

  if (lms.length >= 2) {
    const centers = lms.slice(0, 2).map(extractHandCenter);
    const { A, B } = assignHands(centers);
    appState.handA = pushHistory('A', A, t);
    appState.handB = pushHistory('B', B, t);
    appState.lastSeenAt = t;

    if (A.span < CONFIG.hand.minHandSpan || B.span < CONFIG.hand.minHandSpan) setStatus('TOO_SMALL');
    else if ([A, B].some(p => p.x < CONFIG.hand.edgeMargin || p.x > 1 - CONFIG.hand.edgeMargin ||
                              p.y < CONFIG.hand.edgeMargin || p.y > 1 - CONFIG.hand.edgeMargin)) setStatus('OUT_OF_FRAME');
    else setStatus('TRACKING');
  } else {
    // 짧게 사라진 경우에는 추적을 유지한다
    if (t - appState.lastSeenAt > CONFIG.hand.lostGraceMs) {
      resetTracks();
      setStatus(lms.length === 1 ? 'ONE_HAND' : 'NO_HAND');
    } else {
      setStatus(lms.length === 1 ? 'ONE_HAND' : appState.handStatus);
    }
  }
}

function tick() {
  const t = now();
  const dt = Math.min(0.05, (t - lastFrameTime) / 1000);
  lastFrameTime = t;
  fpsDisplay = fpsDisplay * 0.9 + (1 / Math.max(dt, 0.001)) * 0.1;

  processHands(t);

  const candidate = (appState.handA && appState.handB) ? analyzeMotion(t) : 'IDLE';
  debounceBoundary(candidate, t);

  updateSimulation(dt);
  updateMission(dt);

  renderCamera();
  renderSimulation(t);
  updateInfoPanel();

  requestAnimationFrame(tick);
}

/* =========================================================================
   초기화 · 이벤트 바인딩
   ========================================================================= */
function resetSimulation() {
  const s = appState;
  s.boundary = s.candidateBoundary = 'IDLE';
  s.plateOffset = 0;
  s.slip = 0; s.elastic = 0; s.shearDir = 1;
  s.stress = 0;
  s.crustCreated = 0; s.crustConsumed = 0;
  s.quakeWaves = []; s.shake = 0; s.quakeBadgeUntil = 0;
  s.missionHold = 0;
  resetTracks();
  if (s.mode === 'mission') loadMission(s.missionIndex);
}

function addRecord() {
  const s = appState;
  const c = contentFor(s.boundary, s.convergenceType);
  if (s.boundary === 'IDLE' || s.boundary === 'UNCERTAIN') {
    alert('먼저 판 경계를 하나 만든 뒤 기록해 주세요.');
    return;
  }
  s.records.push({
    motion: c.boundary,
    compose: s.boundary === 'CONVERGENT' ? CONV_LABEL[s.convergenceType] : '–',
    land: c.land,
    quake: c.quake.startsWith('있음') ? '있음' : '없음',
    volcano: c.volcano.startsWith('있음') ? '있음' : '없음'
  });
  els.recordBody.innerHTML = s.records.map(r =>
    `<tr><td>${r.motion}</td><td>${r.compose}</td><td>${r.land}</td><td>${r.quake}</td><td>${r.volcano}</td></tr>`
  ).join('');
}

function bindUI() {
  $('btn-camera').addEventListener('click', startCamera);
  $('btn-free').addEventListener('click', startFreeMode);
  $('btn-mission').addEventListener('click', startMissionMode);
  $('btn-reset').addEventListener('click', resetSimulation);
  $('btn-help').addEventListener('click', () => setHidden($('help-modal'), false));
  $('btn-help-close').addEventListener('click', () => setHidden($('help-modal'), true));
  $('btn-record').addEventListener('click', addRecord);

  $('btn-manual').addEventListener('click', () => setManualMode(!appState.manualMode));
  $('btn-landmark').addEventListener('click', () => {
    appState.landmarkVisible = !appState.landmarkVisible;
    setPressed($('btn-landmark'), appState.landmarkVisible, '랜드마크: ON', '랜드마크: OFF');
  });
  $('btn-sound').addEventListener('click', () => {
    appState.soundEnabled = !appState.soundEnabled;
    if (appState.soundEnabled) ensureAudio();
    setPressed($('btn-sound'), appState.soundEnabled, '소리: ON', '소리: OFF');
  });
  $('btn-debug').addEventListener('click', () => {
    appState.debugVisible = !appState.debugVisible;
    setHidden(els.debugBox, !appState.debugVisible);
    setPressed($('btn-debug'), appState.debugVisible, '디버그: ON', '디버그: OFF');
  });

  document.querySelectorAll('input[name="convtype"]').forEach(r => {
    r.addEventListener('change', () => { appState.convergenceType = r.value; });
  });

  // 튜토리얼
  $('btn-tut-next').addEventListener('click', () => {
    if (tutStep < TUTORIAL.length - 1) { tutStep++; renderTutorial(); }
    else closeTutorial();
  });
  $('btn-tut-skip').addEventListener('click', closeTutorial);

  // 예측 질문
  $('btn-quiz-go').addEventListener('click', () => {
    setHidden($('quiz-modal'), true);
    appState.missionActive = true;
  });

  // 미션
  $('btn-success-next').addEventListener('click', (e) => {
    setHidden($('success-modal'), true);
    if (e.currentTarget.dataset.final) return;
    appState.stress = 0; appState.elastic = 0;
    loadMission(appState.missionIndex + 1);
  });
  $('btn-mission-skip').addEventListener('click', () => {
    setHidden($('success-modal'), true);
    loadMission(appState.missionIndex + 1);
  });

  // 오류 모달
  $('btn-error-retry').addEventListener('click', () => { setHidden($('error-modal'), true); startCamera(); });
  $('btn-error-manual').addEventListener('click', () => { setHidden($('error-modal'), true); setManualMode(true); });

  window.addEventListener('resize', resizeSimCanvas);
}

function initApp() {
  bindUI();
  bindManualControls();
  resizeSimCanvas();
  setStatus('IDLE_CAMERA');
  requestAnimationFrame(tick);
}

initApp();
