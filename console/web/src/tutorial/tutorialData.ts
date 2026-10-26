export type TutorialPill = {
  label: string;
  meaning: string;
  tone: 'ok' | 'neutral' | 'warn';
};

export type TutorialStepItem = {
  title: string;
  summary: string;
  bullets: string[];
  code?: string;
  tip?: string;
};

export type TutorialSection = {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  steps: TutorialStepItem[];
  pills?: TutorialPill[];
};

export type ScreenQuadrant = {
  id: string;
  position: string;
  title: string;
  tabs: string[];
  summary: string;
  highlights: string[];
};

export type TroubleshootingItem = {
  symptom: string;
  where: string;
  cause: string;
  fix: string[];
};

export const QUICK_CHECKLIST: string[] = [
  'Power on the LookCam camera and join it to the Android phone Wi-Fi Hotspot (or connect your PC to the camera AP).',
  'Open the LookCam Bridge app on the phone, tap Start bridge, and verify all 4 phone status pills turn green.',
  'Sign in to the Operator Console, open the bottom Camera tab, and click "1. Open / Reconnect Stream" to view the live feed.',
  'Click "+ Snap Frame -> Agent" (or paste screenshots with Ctrl+V) to send the problem to the AI Coding Agent.',
  'Wait for the 4-stage pipeline (1. Problem -> 2. Cases -> 3. Wrapper -> 4. Solve & Test) to turn green and pass all sample cases.',
  'Open the bottom HID tab, choose "Functions only" + "No leading space", focus the target cursor, and click "Send functions".',
];

export const SCREEN_MAP: ScreenQuadrant[] = [
  {
    id: 'quad-agent',
    position: 'Top-Left Panel',
    title: 'AI Coding Agent & Ask Mode',
    tabs: ['Ask', 'Agent', 'New problem'],
    summary:
      'Reads problem text or up to 15 screenshots, builds a C++ test harness, writes the solution into main.cpp, and verifies it against sample cases.',
    highlights: [
      'Ask mode answers questions about the open C++ file without changing your editor code.',
      'Agent mode runs the 4-step automated solver: 1. Problem -> 2. Cases -> 3. Wrapper -> 4. Solve & Test.',
      'Accepts direct camera snaps, clipboard image paste (Ctrl+V), or drag-and-drop images (PNG, JPEG, WebP).',
    ],
  },
  {
    id: 'quad-tests',
    position: 'Bottom-Left Panel',
    title: 'Test Cases & Stdin/Stdout Diff',
    tabs: ['Case 1', 'Case 2', '+ Add'],
    summary:
      'Holds bare-bones standard input (stdin) and expected output for each test case, showing Pass / Wrong answer / Time limit badges and runtime in milliseconds.',
    highlights: [
      'Automatically populated by the Agent with stripped bare-bones inputs (no "arr[] =" clutter).',
      'Click any case tab to edit Input (stdin), Expected output, or inspect Actual stdout and Stderr.',
      'Green dot means Passed; red dot means Wrong answer, Time limit, or Runtime error.',
    ],
  },
  {
    id: 'quad-editor',
    position: 'Top-Right Panel',
    title: 'Monaco C++ Editor & Live WebRTC Stream',
    tabs: ['main.cpp', 'Stream', 'New tab', 'Run', 'Test'],
    summary:
      'Full C++17 code editor alongside the low-latency live camera stream. Switch between writing code and viewing the remote screen in one click.',
    highlights: [
      'Run compiles with g++ -std=c++17 -O2 and executes ./main once in the Terminal.',
      'Test compiles and runs ./main against every test case in the Bottom-Left panel.',
      'Right-click the Stream tab at any time for quick actions: Live key capture or Snap frame -> Agent.',
    ],
  },
  {
    id: 'quad-bottom',
    position: 'Bottom-Right Panel',
    title: 'Terminal, Camera Controls & HID Keyboard',
    tabs: ['Terminal', 'Camera', 'HID'],
    summary:
      'Houses compiler/program output, LookCam hardware controls and stream recovery, and the ESP32-S3 USB HID keyboard transmitter.',
    highlights: [
      'Terminal tab shows exact g++ compile commands, compiler warnings/errors, and per-case verdicts.',
      'Camera tab snaps frames directly to the Agent, flips orientation, adjusts brightness, and recovers the bridge.',
      'HID tab types your solution into the target machine at human WPM with live editor progress tracking.',
    ],
  },
];

export const TUTORIAL_SECTIONS: TutorialSection[] = [
  {
    id: 'camera-setup',
    badge: 'Step 1',
    title: 'Connecting the Camera (Phone Hotspot & PC Bridge)',
    subtitle:
      'The LookCam camera streams live H.264 video to the Operator Console through a lightweight bridge. This page works without an active bridge, and here is how to connect when you are ready.',
    pills: [
      {
        label: 'Bridge online',
        meaning: 'The phone APK or Python script is actively polling /api/bridge/poll with a valid BRIDGE_TOKEN.',
        tone: 'ok',
      },
      {
        label: 'Camera on',
        meaning: 'The LookCam UDP PPPP session is logged in, clock-synced, and actively sending video packets.',
        tone: 'ok',
      },
      {
        label: 'Ingest publishing',
        meaning: 'Raw H.264 bytes are arriving at /api/bridge/h264 and ffmpeg is publishing to the WebRTC server.',
        tone: 'ok',
      },
      {
        label: 'search / session / login / clock / video',
        meaning: 'Granular 5-stage health checks reported every 3 seconds by the bridge.',
        tone: 'neutral',
      },
    ],
    steps: [
      {
        title: '1A. Recommended Field Setup: Android Phone Hotspot Bridge APK',
        summary:
          'Run the native Android foreground service on the same phone that provides the Wi-Fi hotspot for the camera. The phone talks to the camera over hotspot Wi-Fi and uploads video to the console over mobile data.',
        bullets: [
          'Turn on your Android phone Wi-Fi Hotspot and make sure the LookCam camera has joined that hotspot.',
          'Open the "LookCam Bridge" app (com.operator.bridge) on the phone.',
          'Tap "Connection settings" once and enter: Console URL (e.g. https://webrelay.sahilpatel.online), your Bridge token (at least 16 characters), and Camera id (e.g. GHBB-522328-BWDTT).',
          'Leave "Optional camera IP" empty unless you want to pin a static IP. The app automatically finds the camera using 4 strategies at once: last known IP, directed subnet broadcast, OS neighbor table, and a fast /24 UDP unicast sweep.',
          'Tap "Keep running in background" and allow battery optimization exemption so Android never sleeps the radio when the screen locks.',
          'Tap "Start bridge". Watch the 4 phone pills turn green: Hotspot (subnet detected), Camera (camera IP found), Console (online), and Video (on + byte counter rising).',
        ],
        tip: 'The camera password is never typed into the phone app. The Operator Console delivers it securely over the authenticated bearer channel once the phone connects.',
      },
      {
        title: '1B. Alternative Setup: Laptop / PC Python Bridge',
        summary:
          'If you are running the bridge from a computer connected to the camera Wi-Fi access point (192.168.12.x) or shared LAN, run the Python bridge script.',
        bullets: [
          'Copy bridge/env.example to bridge/.env and fill in BRIDGE_URL, BRIDGE_TOKEN, and LOOKCAM_DEVICE.',
          'Run the bridge script from a terminal; it performs the same UDP discovery, 180ms packet-gap skipping, and chunked H.264 upload.',
        ],
        code: `# Inside bridge/
cp env.example .env
# Edit .env with BRIDGE_URL and BRIDGE_TOKEN
python3 scripts/lookcam_bridge.py`,
      },
      {
        title: '1C. Viewing, Flipping & Recovering the Stream in the Console',
        summary:
          'Once the bridge is running, control everything from the bottom-right "Camera" tab and top-right "Stream" tab.',
        bullets: [
          'Open the bottom "Camera" tab to see connection pills. Video only streams when a viewer opens the Stream tab or the Camera tab is kept warm.',
          'Click "1. Open / Reconnect Stream" to switch the upper-right pane to the live WebRTC player.',
          'Click "Stop stream" when you want to pause camera transmission and save battery/data until you click Open again.',
          'Click "2. Stream 2 -> 3" (or 3 -> 2) to toggle between camera stream profiles if you want sharper text or lower bitrate.',
          'Click "3. Recover Bridge" if the camera Wi-Fi hiccups; this instructs the bridge to reset its UDP session immediately.',
          'Under "Orientation & Picture", click "Flip Horizontal (Mirror)" or "Flip Vertical (Upside-Down)" if the physical camera is mounted inverted, and use the Brightness 20% / 40% / 60% / 80% presets to eliminate monitor glare.',
        ],
      },
    ],
  },
  {
    id: 'agent-workflow',
    badge: 'Step 2',
    title: 'Capturing a Problem & Using the AI Coding Agent',
    subtitle:
      'The top-left Agent pane is a harness-first C++ coding assistant. You can feed it problems from the camera, screenshots, or text, and it will write and test the solution automatically.',
    steps: [
      {
        title: '2A. Three Ways to Send a Problem to the Agent',
        summary:
          'You never need to transcribe a problem by hand. Choose whichever capture method fits your setup:',
        bullets: [
          'Method 1 — Direct Camera Snap (Fastest): In the bottom "Camera" tab (or by right-clicking the "Stream" tab), click "+ Snap Frame -> Agent" to grab a crisp PNG directly from the live video player, or "+ Snap Agent -> Agent" to trigger the remote capture agent. Check "Start new problem on capture" if you want it to reset the previous problem automatically.',
          'Method 2 — Multi-Screenshot Paste or Drag & Drop: Take up to 15 screenshots (for long scrolling problems) and press Ctrl+V directly inside the Agent message box, or drag and drop PNG/JPEG/WebP files onto the Agent panel.',
          'Method 3 — Text & Starter Code: Paste problem descriptions, constraints, or a required class/function template into the message box and press Ctrl+Enter (or click Send).',
        ],
        tip: 'If a problem statement spans two pages, snap the first page, scroll the target screen, and snap the second page before clicking Send. The Agent combines all attached images in order (1. part-1, 2. part-2).',
      },
      {
        title: '2B. Understanding the 4-Stage Agent Pipeline',
        summary:
          'When you send a problem in "Agent" mode, watch the progress pills at the top of the Agent pane:',
        bullets: [
          '1. Problem: Extracts the clean problem statement, constraints, and required function or class signature (or defaults to void solve() with #include <bits/stdc++.h>).',
          '2. Cases: Converts verbose sample examples (such as "Input: nums = [2,7,11,15], target = 9") into bare-bones competitive programming stdin ("4\\n2 7 11 15\\n9") and populates the Bottom-Left Test Cases pane.',
          '3. Wrapper: Builds a complete main() test harness around your target function or class so the solution can be compiled and tested locally with g++.',
          '4. Solve & Test: Writes the C++17 implementation into main.cpp, compiles it, and runs every sample test case. If a case fails or hits a compiler error, the Agent automatically iterates up to 3 attempts.',
        ],
      },
      {
        title: '2C. Ask Mode vs. Agent Mode & Human Guidance Buttons',
        summary:
          'You stay in full control before, during, and after the Agent runs:',
        bullets: [
          'Ask Mode (Safe Read-Only): Switch the top-left toggle to "Ask" to ask questions about time complexity, edge cases, or how the current code in main.cpp works. Ask mode never overwrites your editor or test cases.',
          '+ Edge cases: Generates tricky boundary test cases (n=1, all-equal, maximum constraints) and verifies the code against them.',
          'Another approach: Tells the Agent to rewrite the solution using a different algorithm or lower complexity.',
          'Cases are wrong: If the OCR misread a sample number from a blurry photo, edit the case in the Test Cases pane or click "Cases are wrong" so the Agent re-evaluates.',
          'New problem: Clears the conversation and resets the pipeline for the next question.',
        ],
      },
    ],
  },
  {
    id: 'editor-testing',
    badge: 'Step 3',
    title: 'Writing C++ Code & Running Test Cases Manually',
    subtitle:
      'Whether you write C++ from scratch or tweak the Agent’s solution, the Monaco editor and local g++ runner give instant feedback.',
    steps: [
      {
        title: '3A. Working in the Monaco C++ Editor',
        summary:
          'The upper-right panel is a full VS Code-style C++ editor with multi-tab support.',
        bullets: [
          'Click "New tab" in the top-right bar to open additional scratch files (file-2.cpp, etc.). Drag tabs left or right to reorder them.',
          'A blue dot (●) on a tab means the file has been modified from the starter template.',
          'Switch between your code tab (main.cpp) and the "Stream" tab at any time without losing your cursor position or stopping the video stream.',
        ],
      },
      {
        title: '3B. Run vs. Test',
        summary:
          'There are two execution buttons in the top-right bar of the editor:',
        bullets: [
          'Run: Compiles the active tab with g++ -std=c++17 -O2 -pipe -Wall -Wextra -o main and runs ./main once with empty stdin, printing stdout/stderr and execution time in the bottom-right Terminal tab.',
          'Test: Compiles the active tab and runs ./main against every case in the bottom-left Test Cases panel. Each case receives its own Input (stdin), and its output is compared against Expected.',
        ],
        code: `$ g++ -std=c++17 -O2 -pipe -Wall -Wextra -o main main.cpp
case 1  pass  4ms
case 2  pass  3ms`,
      },
      {
        title: '3C. Managing Test Cases',
        summary:
          'Use the bottom-left Test Cases panel to inspect or customize inputs and outputs.',
        bullets: [
          'Click "+ Add" to create a custom test case, or "Remove" to delete the selected case.',
          'Edit "Input (stdin)" and "Expected" at any time; editing a case resets its badge to Idle until the next Test run.',
          'After clicking Test, compare "Expected" and "Actual" side-by-side. Any runtime crash or sanitizer message appears in the "Stderr" box.',
        ],
      },
    ],
  },
  {
    id: 'hid-typing',
    badge: 'Step 4',
    title: 'Writing & Typing to the Target Machine (HID Keyboard)',
    subtitle:
      'The bottom-right "HID" tab connects to the ESP32-S3 hardware USB keyboard/mouse emulator so you can type code or control the remote computer smoothly.',
    pills: [
      {
        label: 'Keyboard Connected',
        meaning: 'The ESP32-S3 device is connected to /ws/device on the server and ready to emit USB keystrokes.',
        tone: 'ok',
      },
      {
        label: 'HID ready',
        meaning: 'DEVICE_TOKEN is configured on the server.',
        tone: 'ok',
      },
      {
        label: 'Socket open',
        meaning: 'Your browser has an active WebSocket link to the console for live key/mouse forwarding.',
        tone: 'ok',
      },
    ],
    steps: [
      {
        title: '4A. Mode 1 — Paced Automated Code Typing (Best for Submitting Code)',
        summary:
          'Types your solution from main.cpp (or custom text) at a realistic human typing speed with configurable jitter.',
        bullets: [
          '1. Choose Code Scope ("Code"):\n• "Functions only" (Recommended for online judges): Strips #include lines and the local main() test wrapper so only your target function/class and helpers are typed into the platform’s starter editor.\n• "With wrapper": Types the entire C++ file from top to bottom.',
          '2. Choose Indentation ("Indent"):\n• "No leading space" (Recommended for web IDEs): Strips leading spaces on each line because browser code editors automatically indent after Enter. This prevents the dreaded "staircase" double-indentation.\n• "Keep spaces": Types every leading space literally (use for plain text editors like Notepad or nano).',
          '3. Set Speed & Jitter: Adjust "Speed" (20–300 WPM, default 80 WPM) and "Jitter" (0–50%, default 25%) for natural human variation. The green pill shows the exact character count and estimated time.',
          '4. Click "Send functions" (or "Send main.cpp"): Switch to the Stream tab or watch the Monaco editor—characters already typed highlight in green, and a blue caret tracks the exact live typing position!',
          '5. Pause, Resume, or Cancel: If a popup steals focus on the remote computer, click "Pause" immediately, re-focus the remote editor cursor, and click "Resume" to continue from the exact character where it stopped.',
        ],
        tip: 'Need to type a quick snippet that is not in main.cpp? Paste up to 4,000 characters into the bottom "Or paste custom text to type…" box and click "Send paste".',
      },
      {
        title: '4B. Mode 2 — Continuous Editor Typing',
        summary:
          'Forwards every keystroke you type inside the Monaco editor directly to the remote USB keyboard in real time.',
        bullets: [
          'In the bottom "HID" tab, check "Continuous editor typing".',
          'Click inside the Monaco C++ editor and type normally. Every printable key, Backspace, Enter, and arrow key is sent immediately to the target machine while you edit locally.',
          'Uncheck "Continuous editor typing" when you want to edit locally without sending keys.',
        ],
      },
      {
        title: '4C. Mode 3 — Live Stream Keyboard & Mouse Control',
        summary:
          'Type and move the mouse directly while watching the live video feed in the "Stream" tab.',
        bullets: [
          'Hover over the bottom of the live video in the "Stream" tab and check "Live key capture" (or right-click the "Stream" tab and choose "Live, typing keys" or "Live, all keys").',
          'Live, typing keys forwards text, numbers, Enter, Backspace, Tab, and Space while showing the last 6 keys pressed as floating keychips on the video.',
          'Live, all keys also forwards modifiers, function keys, and navigation shortcuts.',
          'Click anywhere on the video while in Live mode to lock your mouse pointer and control the remote cursor and scroll wheel. Press Esc at any time to unlock your mouse.',
        ],
      },
    ],
  },
];

export const TROUBLESHOOTING_ITEMS: TroubleshootingItem[] = [
  {
    symptom: 'Stream says "No signal" even though Bridge is online',
    where: 'Stream Tab / Camera Tab',
    cause:
      'Either the stream was manually stopped, the camera has not finished logging in yet, or the UDP video channel stalled on Wi-Fi.',
    fix: [
      'Open the bottom "Camera" tab and check the pills: Bridge online, Camera on, and Ingest publishing should all be green.',
      'Click "1. Open / Reconnect Stream". If Camera stays "starting", click "2. Stream 2 -> 3" or "3. Recover Bridge".',
      'On the Android phone app, verify the phone hotspot is active and tap "Reconnect camera" if the camera IP changed.',
    ],
  },
  {
    symptom: 'Camera check says "login was rejected" or "camera password is not configured"',
    where: 'Camera Tab Checks',
    cause:
      'LOOKCAM_PASSWORD on the console server does not match the camera’s current password.',
    fix: [
      'Verify LOOKCAM_PASSWORD in the console server environment (.env or Coolify) matches the camera password (default is usually 6666 or your custom password).',
      'Click "3. Recover Bridge" in the Camera tab to retry login immediately.',
    ],
  },
  {
    symptom: 'Typed code looks like a staircase (double-indented on every line)',
    where: 'HID Tab -> Code Typing',
    cause:
      'Most web coding platforms auto-indent when Enter is pressed, so sending leading spaces adds extra indentation on every line.',
    fix: [
      'Click "Cancel" in the HID tab.',
      'Set Indent to "No leading space" and Code to "Functions only", then re-send.',
    ],
  },
  {
    symptom: 'HID tab says "Keyboard Offline" or "HID is not configured"',
    where: 'HID Tab',
    cause:
      'The ESP32-S3 dongle is not powered/connected to Wi-Fi, or DEVICE_TOKEN does not match between the server and firmware.',
    fix: [
      'Confirm the ESP32-S3 is plugged into the target USB port and has joined Wi-Fi.',
      'Ensure DEVICE_TOKEN in the console server matches WS_HOST / WS_PORT / DEVICE_TOKEN in the ESP32 secrets.h.',
    ],
  },
];
