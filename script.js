// ---------------- Fill in your Firebase project config ----------------
  const firebaseConfig = {
    apiKey: "AIzaSyCDzjlIarL2CFVROdkvY09wzE5eymwkAh4",
    authDomain: "solar-charging-epayment.firebaseapp.com",
    databaseURL: "https://solar-charging-epayment-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "solar-charging-epayment",
    storageBucket: "solar-charging-epayment.firebasestorage.app",
    messagingSenderId: "560912540285",
    appId: "1:560912540285:web:ee8a922e2d5213445c8714",
  };
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.database();

  let currentUid = null; // currently displayed card UID (Card Lookup tab)
  let reportAdminVerified = false; // report exports require verified admin access

  // ---------------- Auth + Super Admin gate ----------------
  // Signing in is not enough. The UID must also exist under admins/{uid},
  // a node that can only be written from the Firebase console. Any other
  // account — a reloader, a customer, a stranger who guessed a password —
  // is signed straight back out.
  const ADMIN_DENIED = 'Access denied. Super Admin account required.';
  let adminSignOutNotice = null;

  auth.onAuthStateChanged((user) => {
    if (!user) { showAdminLoginScreen(); return; }

    db.ref('admins/' + user.uid).once('value').then((snap) => {
      if (!snap.exists() || snap.val() === false) {
        forceAdminSignOut(ADMIN_DENIED);
        return;
      }
      enterAdminConsole();
    }).catch(() => {
      // A permission-denied read means this account is not on the roster
      // as far as the database rules are concerned — same outcome.
      forceAdminSignOut(ADMIN_DENIED);
    });
  });

  // Shared error callback for every realtime listener. Without one, a
  // denied read fails silently and the panel just stays blank.
  function dbError(label, show) {
    return (err) => {
      console.error('Read failed on ' + label, err);
      (show || showStatus)('error',
        'Cannot read ' + label + ': ' + err.code +
        '. Check that your UID exists under admins/ in the database.');
    };
  }

  function enterAdminConsole() {
    reportAdminVerified = true;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    document.getElementById('loginPass').value = '';
    attachAdminListeners();
    showTab('overview');
  }

  function showAdminLoginScreen() {
    ++adminCardLookupSequence;
    reportAdminVerified = false;
    reportCurrent = null;
    detachAdminListeners();
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';

    if (adminSignOutNotice) {
      showLoginError(adminSignOutNotice);
      adminSignOutNotice = null;
    }
  }

  function forceAdminSignOut(message) {
    reportAdminVerified = false;
    reportCurrent = null;
    adminSignOutNotice = message;
    detachAdminListeners();
    auth.signOut();
  }

  function showLoginError(msg) {
    const el = document.getElementById('loginError');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function hideLoginError() {
    document.getElementById('loginError').style.display = 'none';
  }

  function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPass').value;
    hideLoginError();

    if (!email || !pass) {
      showLoginError('Enter both your email and password.');
      return;
    }

    auth.signInWithEmailAndPassword(email, pass).catch(() => {
      showLoginError('Sign-in failed: check the email and password.');
    });
  }

  function doLogout() {
    detachAdminListeners();
    auth.signOut();
  }

  // ---------------- Tabs ----------------
  function showTab(name) {
    ['overview','lookup', 'reloads', 'users', 'reloaders', 'reports', 'station'].forEach((t) => {
      document.getElementById('tabPanel-' + t).classList.toggle('active', t === name);
      document.getElementById('tabBtn-' + t).classList.toggle('active', t === name);
    });
    setDashboardPage(name);
    toggleMobileNav(false);
    if (name === 'overview') renderOverview();
  }

  // ---------------- Realtime listeners (admin-only; attached after sign-in) ----------------
  let pendingReloadsRef = null;
  let usersRef = null;
  let batteryRef = null;
  let battStaleTimer = null;
  let battLast = null;          // last battery snapshot (Station tab)
  let allUsersCache = {};
  let reloadersRef = null;
  let allReloadersCache = {};
  let branchesRef = null;
  let allBranchesCache = {};
  let branchesLoaded = false;

  function attachAdminListeners() {
    detachAdminListeners();   // never stack a second set of listeners

    pendingReloadsRef = db.ref('pending_reloads');
    pendingReloadsRef.on('value', (snap) => { ovPendingCache = snap.val() || {}; ovPendingLoaded = true; renderPendingReloads(snap); renderOverview(); }, dbError('pending reloads', showReloadsStatus));

    usersRef = db.ref('users');
    usersRef.on('value', (snap) => {
      allUsersCache = snap.val() || {};
      renderUsersTable();
      reportUsersLoaded = true;
      renderOverview();
      if (reportAdminVerified) renderSalesReport();
    }, dbError('registered users', showRegisterStatus));

    reloadersRef = db.ref('reloaders');
    reloadersRef.on('value', (snap) => {
      allReloadersCache = snap.val() || {};
      renderReloadersTable();
      renderBranchesTable();
      reportReloadersLoaded = true;
      renderOverview();
      reportPopulateStores();
      if (reportAdminVerified) renderSalesReport();
    }, dbError('reloaders', showReloaderStatus));

    branchesRef = db.ref('branches');
    branchesRef.on('value', (snap) => {
      allBranchesCache = snap.val() || {};
      branchesLoaded = true;
      renderOverview();
      renderBranchesTable();
      renderReloadersTable();
      refreshReloaderBranchSelectors();
      reportPopulateStores();
      if (reportAdminVerified) renderSalesReport();
    }, (err) => {
      branchesLoaded = false;
      const message = err && err.code === 'PERMISSION_DENIED'
        ? 'Firebase does not yet allow branch registry reads. Add the branches security rules described in the setup note before registering branches.'
        : 'Could not load branches: ' + (err && err.message || 'unknown error');
      showBranchStatus('error',message);
    });

    batteryRef = db.ref('battery');
    batteryRef.on('value', (snap) => {
      battLast = snap.val();
      renderBattery(battLast);
      renderOverview();
    }, dbError('battery', showStatus));


    // Re-render on a timer so the "station offline" warning still appears
    // when the ESP32 goes quiet and no new snapshot ever arrives.
    battStaleTimer = setInterval(() => { if (battLast) renderBattery(battLast); renderOverview(); }, 10000);
  }

  function detachAdminListeners() {
    if (pendingReloadsRef) { pendingReloadsRef.off(); pendingReloadsRef = null; }
    if (usersRef) { usersRef.off(); usersRef = null; }
    if (reloadersRef) { reloadersRef.off(); reloadersRef = null; }
    if (branchesRef) { branchesRef.off(); branchesRef = null; }
    if (batteryRef) { batteryRef.off(); batteryRef = null; }
    if (battStaleTimer) { clearInterval(battStaleTimer); battStaleTimer = null; }
    battLast = null;
    allUsersCache = {};
    allReloadersCache = {};
    allBranchesCache = {};
    branchesLoaded = false;
    ovPendingCache = {};
    ovPendingLoaded = false;
    reportUsersLoaded = false;
    reportReloadersLoaded = false;
    reportCurrent = null;
    branchDeleteAllowed = false;
    branchDeleteToken++;
    document.getElementById('editBranchOverlay').classList.remove('show');
    document.getElementById('deleteBranchOverlay').classList.remove('show');
    reportToggleExports(false);
  }

  // ================================================================
  // ============ TAB 1: CARD LOOKUP (existing behavior) ============
  // ================================================================
  let adminCardLookupSequence = 0;
  function searchCard() {
    const query = document.getElementById('searchInput').value.trim().toUpperCase();
    if (!query) return;

    const request = ++adminCardLookupSequence;
    currentUid = null; // Do not leave a previously searched card selected.
    hideCards();
    showStatus('info', 'Searching…');

    // Try as a direct UID key first; preserve the existing phone fallback.
    db.ref('users/' + query).once('value').then((snap) => {
      if (request !== adminCardLookupSequence || !reportAdminVerified) return;
      if (snap.exists()) {
        renderUser(query, snap.val());
        return;
      }
      return db.ref('users').orderByChild('phone').equalTo(query).once('value').then((snap2) => {
        if (request !== adminCardLookupSequence || !reportAdminVerified) return;
        if (snap2.exists()) {
          const uid = Object.keys(snap2.val())[0];
          renderUser(uid, snap2.val()[uid]);
        } else {
          showStatus('error', 'No card found for "' + query + '".');
        }
      });
    }).catch((err) => {
      if (request === adminCardLookupSequence && reportAdminVerified)
        showStatus('error', 'Lookup failed: ' + err.message);
    });
  }

  function renderUser(uid, data) {
    currentUid = uid;
    hideStatus();

    document.getElementById('userName').textContent = data.name || 'Unnamed cardholder';
    document.getElementById('userUid').textContent = uid;
    document.getElementById('userPhone').textContent = data.phone || 'No phone on file';

    const statusEl = document.getElementById('userStatus');
    const status = data.status || 'active';
    statusEl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    statusEl.className = 'status-pill ' + (status === 'active' ? 'active' : 'blocked');

    const balance = data.balance || 0;
    document.getElementById('balanceValue').textContent = balance.toFixed(2);
    // Gauge is a visual reference, not a literal percentage — capped at ₱500 for a full bar
    const gaugePct = Math.min(100, (balance / 500) * 100);
    document.getElementById('gaugeFill').style.width = gaugePct + '%';

    renderTransactions(data.transactions || {});

    document.getElementById('userCard').classList.add('show');
    document.getElementById('txCard').classList.add('show');
  }

  function renderTransactions(transactions) {
    const body = document.getElementById('txBody');
    const empty = document.getElementById('txEmpty');
    body.innerHTML = '';

    // The ESP32 gateway writes UNIX seconds; every web write uses milliseconds.
    // Normalise before sorting, or charge rows always sink below reload rows.
    const txTime = (t) => {
      const n = Number(t) || 0;
      return n < 100000000000 ? n * 1000 : n;
    };
    const entries = Object.values(transactions).sort((a, b) => txTime(b.timestamp) - txTime(a.timestamp));

    if (entries.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    entries.slice(0, 15).forEach((tx) => {
      const row = document.createElement('tr');
      const type = tx.type || 'charge';
      const sign = type === 'reload' ? '+' : '−';
      const when = tx.timestamp ? new Date(txTime(tx.timestamp)).toLocaleString() : '—';
      const methodTag = tx.method ? ' (' + tx.method + (tx.reference ? ' · ' + tx.reference : '') + ')' : '';

      row.innerHTML = `
        <td>${type}${methodTag}</td>
        <td class="tx-amount ${type}">${sign}₱${(tx.amount || 0).toFixed(2)}</td>
        <td>₱${(tx.balanceAfter || 0).toFixed(2)}</td>
        <td>${when}</td>
      `;
      body.appendChild(row);
    });
  }

  function setQuickAmount(amount) {
    document.getElementById('reloadAmount').value = amount;
  }

  function reloadBalance() {
    if (!currentUid) return;
    const amountInput = document.getElementById('reloadAmount');
    const amount = parseFloat(amountInput.value);

    if (!amount || amount <= 0) {
      showStatus('error', 'Enter a valid amount to add.');
      return;
    }

    const balanceRef = db.ref('users/' + currentUid + '/balance');

    balanceRef.transaction((current) => (current || 0) + amount).then((result) => {
      if (!result.committed) {
        showStatus('error', 'Reload failed — try again.');
        return;
      }
      const newBalance = result.snapshot.val();

      db.ref('users/' + currentUid + '/transactions').push({
        amount: amount,
        balanceAfter: newBalance,
        type: 'reload',
        method: 'admin',
        timestamp: Date.now(),
      }).catch((err) => showStatus('error',
        'Balance was updated but the receipt failed to save: ' + err.message));

      showStatus('success', `Added ₱${amount.toFixed(2)}. New balance: ₱${newBalance.toFixed(2)}.`);
      amountInput.value = '';

      // Refresh the displayed card
      db.ref('users/' + currentUid).once('value').then((snap) => renderUser(currentUid, snap.val()));
    }).catch((err) => {
      showStatus('error', 'Reload failed: ' + err.message);
    });
  }

  function showStatus(kind, msg) {
    const el = document.getElementById('statusMsg');
    el.textContent = msg;
    el.className = 'status-msg show ' + kind;
  }
  function hideStatus() {
    document.getElementById('statusMsg').className = 'status-msg';
  }
  function hideCards() {
    document.getElementById('userCard').classList.remove('show');
    document.getElementById('txCard').classList.remove('show');
  }

  document.getElementById('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchCard();
  });

  // ================================================================
  // ==== 13.56 MHz R20XC-USB RFID TAP-TO-SEARCH + TAP-TO-REGISTER ====
  // ================================================================
  // Based on four verified card pairs from the TAMBAYAN project:
  // decimal reader output -> hexadecimal MFRC522 UID (reverse byte order).
  // Works only for this reader's confirmed 10-decimal-digit / 4-byte format.
  function usbDecimalToMFRC522(raw) {
    const digits = String(raw).trim();
    if (!/^\d{10}$/.test(digits)) {
      throw new Error('Expected a 10-digit decimal UID from the USB RFID reader.');
    }
    const number = BigInt(digits);
    if (number > 0xFFFFFFFFn) {
      throw new Error('This reader output exceeds a four-byte UID.');
    }
    const hex = number.toString(16).toUpperCase().padStart(8, '0');
    return hex.match(/.{2}/g).reverse().join('');
  }

  // Scanner data is delivered as rapid keyboard events. Recording the original
  // focused field value lets us undo the nine digits typed into an unrelated
  // form field, e.g. Phone, Initial Balance, or Name, before the scan completes.
  const ADMIN_RFID_INTERKEY_MS = 125;
  const ADMIN_RFID_MAX_SCAN_MS = 1200;
  let adminRfidDigits = '';
  let adminRfidStartedAt = 0;
  let adminRfidLastAt = 0;
  let adminRfidTarget = null;
  let adminRfidOriginalValue = '';
  let adminRfidIgnoreEnterUntil = 0;
  let adminRfidRegistrationCheck = 0;

  function adminRfidActiveScreen() {
    if (!reportAdminVerified || !auth.currentUser ||
        document.getElementById('dashboard').style.display === 'none') return null;
    if (document.getElementById('tabPanel-lookup').classList.contains('active')) return 'lookup';
    if (document.getElementById('tabPanel-users').classList.contains('active')) return 'users';
    return null;
  }

  function adminRfidModalOpen() {
    return !!document.querySelector('.modal-overlay.show');
  }

  function adminRfidResetBuffer() {
    adminRfidDigits = '';
    adminRfidTarget = null;
    adminRfidOriginalValue = '';
  }

  function adminRfidReceiveScan(decimalText) {
    let uid;
    try {
      uid = usbDecimalToMFRC522(decimalText);
    } catch (err) {
      const destination = adminRfidActiveScreen();
      if (destination === 'lookup') showStatus('error', 'RFID scan: ' + err.message);
      if (destination === 'users') showRegisterStatus('error', 'RFID scan: ' + err.message);
      return;
    }

    const destination = adminRfidActiveScreen();
    if (!destination || adminRfidModalOpen()) return;
    if (destination === 'lookup') {
      const search = document.getElementById('searchInput');
      search.value = uid;
      searchCard(); // Search only. Never add card balance automatically.
      return;
    }

    const form = document.getElementById('registerForm');
    const uidField = document.getElementById('regUid');
    const priorUid = uidField.value.trim().toUpperCase();
    const hasDraft = ['regName', 'regPhone', 'regBalance'].some(id =>
      document.getElementById(id).value.trim() !== '');

    // Prevent a second card from silently inheriting an unfinished customer's
    // details. The admin can save or clear their draft before scanning again.
    if (hasDraft && priorUid && priorUid !== uid) {
      showRegisterStatus('error',
        'New scan ' + uid + ' was not applied: registration details for ' +
        priorUid + ' are already filled in. Save that card or clear the form before scanning another.');
      return;
    }
    if (hasDraft && !priorUid) {
      showRegisterStatus('error',
        'Card ' + uid + ' was detected, but customer details are already entered. Clear or save the form before scanning a different card.');
      return;
    }
    if (form.style.display !== 'block') toggleRegisterForm();
    uidField.value = uid;

    const check = ++adminRfidRegistrationCheck;
    showRegisterStatus('info', 'RFID card ' + uid + ' captured. Checking registration status…');
    db.ref('users/' + uid).once('value').then(snap => {
      if (check !== adminRfidRegistrationCheck ||
          uidField.value.trim().toUpperCase() !== uid ||
          adminRfidActiveScreen() !== 'users') return;
      if (snap.exists()) {
        const data = snap.val() || {};
        showRegisterStatus('error', 'Card ' + uid + ' is already registered' +
          (data.name ? ' to ' + data.name : '') + '. Use Card Lookup or Edit instead.');
        uidField.focus();
      } else {
        showRegisterStatus('success', 'New card ' + uid + ' captured. Enter customer details and click Save new card to register.');
        document.getElementById('regName').focus();
      }
    }).catch(err => {
      if (check === adminRfidRegistrationCheck) {
        showRegisterStatus('error', 'Card captured, but Firebase lookup failed: ' + err.message);
        uidField.focus();
      }
    });
  }

  document.addEventListener('keydown', (event) => {
    const now = performance.now();
    // Many readers append Enter. Do not let the suffix click a button or
    // trigger an unrelated action, including a form's confirmation button.
    if (event.key === 'Enter' && now < adminRfidIgnoreEnterUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (!adminRfidActiveScreen() || event.ctrlKey || event.altKey ||
        event.metaKey || event.isComposing || event.repeat) {
      adminRfidResetBuffer();
      return;
    }
    if (!/^\d$/.test(event.key)) {
      adminRfidResetBuffer();
      return;
    }
    if (!adminRfidDigits || now - adminRfidLastAt > ADMIN_RFID_INTERKEY_MS ||
        now - adminRfidStartedAt > ADMIN_RFID_MAX_SCAN_MS ||
        event.target !== adminRfidTarget) {
      adminRfidDigits = '';
      adminRfidStartedAt = now;
      adminRfidTarget = event.target;
      adminRfidOriginalValue = (event.target && 'value' in event.target)
        ? event.target.value : '';
    }
    adminRfidDigits += event.key;
    adminRfidLastAt = now;
    if (adminRfidDigits.length !== 10) return;

    const raw = adminRfidDigits;
    const target = adminRfidTarget;
    const original = adminRfidOriginalValue;
    adminRfidResetBuffer();
    adminRfidIgnoreEnterUntil = now + 350;
    event.preventDefault();
    event.stopImmediatePropagation();

    // Preserve manually entered text/values in any previously focused field.
    if (target && 'value' in target) {
      target.value = original;
      // Refresh existing filters and UI tied to input events as well.
      target.dispatchEvent(new Event('input', { bubbles: true }));
    }
    adminRfidReceiveScan(raw);
  }, true);

  // Direct paste into these two UID fields is also supported, without
  // interfering with manual Card Lookup by phone number.
  document.getElementById('searchInput').addEventListener('paste', (e) => {
    if (adminRfidActiveScreen() !== 'lookup') return;
    const text = (e.clipboardData && e.clipboardData.getData('text') || '').trim();
    if (!/^\d{10}$/.test(text)) return;
    // Pasting a decimal reader ID is treated as a scan only in the UID field.
    e.preventDefault();
    adminRfidReceiveScan(text);
  });
  document.getElementById('regUid').addEventListener('paste', (e) => {
    if (adminRfidActiveScreen() !== 'users') return;
    const text = (e.clipboardData && e.clipboardData.getData('text') || '').trim();
    if (!/^\d{10}$/.test(text)) return;
    e.preventDefault();
    adminRfidReceiveScan(text);
  });


  // ================================================================
  // ============ TAB 2: PENDING GCASH RELOADS ============
  // ================================================================
  // Data model:
  //   pending_reloads/{pushId}        = { uid, amount, reference, timestamp }
  //   pending_reference_index/{ref}   = true   (lets the public reload page check
  //                                              "is this reference already queued?"
  //                                              without reading other people's requests)
  //   used_references/{ref}           = { uid, amount, approvedAt }  (set once approved,
  //                                              blocks the same reference forever)
  function renderPendingReloads(snap) {
    const data = snap.val() || {};
    const entries = Object.entries(data).sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0)); // oldest first

    const body = document.getElementById('pendingBody');
    const empty = document.getElementById('pendingEmpty');
    const badge = document.getElementById('reloadBadge');
    body.innerHTML = '';

    if (entries.length === 0) {
      empty.style.display = 'block';
      badge.style.display = 'none';
    } else {
      empty.style.display = 'none';
      badge.style.display = 'inline-block';
      badge.textContent = entries.length;
    }

    entries.forEach(([key, req]) => {
      const row = document.createElement('tr');
      const when = req.timestamp ? new Date(req.timestamp).toLocaleString() : '—';
      const cardCellId = 'cardCell-' + key;

      row.innerHTML = `
        <td>${when}</td>
        <td class="mono" id="${cardCellId}">${req.uid}</td>
        <td class="mono">${req.reference}</td>
        <td class="mono">₱${(req.amount || 0).toFixed(2)}</td>
        <td>
          <button class="btn-approve" onclick="approveReload('${key}')">Approve</button>
          <button class="btn-reject" onclick="rejectReload('${key}')">Reject</button>
        </td>
      `;
      body.appendChild(row);

      // Best-effort: show the cardholder's name too, if this UID is registered
      db.ref('users/' + req.uid + '/name').once('value').then((nameSnap) => {
        const cell = document.getElementById(cardCellId);
        if (cell && nameSnap.exists()) {
          cell.innerHTML = nameSnap.val() + '<br><span class="uid-tag" style="margin-top:4px;display:inline-block;">' + req.uid + '</span>';
        }
      });
    });
  }

  function approveReload(key) {
    db.ref('pending_reloads/' + key).once('value').then((snap) => {
      const req = snap.val();
      if (!req) {
        showReloadsStatus('error', 'This request no longer exists (maybe already handled).');
        return;
      }
      const uid = req.uid, amount = req.amount, reference = req.reference;

      // Defense in depth: someone shouldn't be able to approve the same reference twice
      db.ref('used_references/' + reference).once('value').then((usedSnap) => {
        if (usedSnap.exists()) {
          showReloadsStatus('error', 'Reference ' + reference + ' was already used for a previous approval — reject this duplicate instead.');
          return;
        }

        db.ref('users/' + uid).once('value').then((userSnap) => {
          if (!userSnap.exists()) {
            showReloadsStatus('error', 'Card ' + uid + ' is not registered. Register it under Manage Users, then approve again.');
            return;
          }

          const balanceRef = db.ref('users/' + uid + '/balance');
          balanceRef.transaction((current) => (current || 0) + amount).then((result) => {
            if (!result.committed) {
              showReloadsStatus('error', 'Approval failed — try again.');
              return;
            }
            const newBalance = result.snapshot.val();

            db.ref('users/' + uid + '/transactions').push({
              amount: amount,
              balanceAfter: newBalance,
              type: 'reload',
              method: 'gcash',
              reference: reference,
              timestamp: Date.now(),
            }).catch((err) => showReloadsStatus('error',
              'Balance was updated but the receipt failed to save: ' + err.message));

            // Close out the request: mark the reference used, remove it from the
            // pending queue and from the public "still pending" index — all at once.
            const updates = {};
            updates['used_references/' + reference] = { uid: uid, amount: amount, approvedAt: Date.now() };
            updates['pending_reloads/' + key] = null;
            updates['pending_reference_index/' + reference] = null;
            db.ref().update(updates);

            showReloadsStatus('success', 'Approved ₱' + amount.toFixed(2) + ' for ' + uid + '. New balance: ₱' + newBalance.toFixed(2) + '.');
          }).catch((err) => showReloadsStatus('error', 'Approval failed: ' + err.message));
        });
      });
    });
  }

  function rejectReload(key) {
    if (!confirm('Reject this reload request? This cannot be undone.')) return;

    db.ref('pending_reloads/' + key).once('value').then((snap) => {
      const req = snap.val();
      const updates = {};
      updates['pending_reloads/' + key] = null;
      if (req && req.reference) {
        updates['pending_reference_index/' + req.reference] = null;
      }
      return db.ref().update(updates);
    }).then(() => {
      showReloadsStatus('info', 'Request rejected and removed.');
    }).catch((err) => {
      showReloadsStatus('error', 'Reject failed: ' + err.message);
    });
  }

  function showReloadsStatus(kind, msg) {
    const el = document.getElementById('reloadsStatusMsg');
    el.textContent = msg;
    el.className = 'status-msg show ' + kind;
  }

  // ================================================================
  // ============ TAB 3: MANAGE USERS (CRUD) ============
  // ================================================================
  function showRegisterStatus(kind, msg) {
    const el = document.getElementById('registerStatusMsg');
    el.textContent = msg;
    el.className = 'status-msg show ' + kind;
  }

  function toggleRegisterForm() {
    const form = document.getElementById('registerForm');
    const isOpen = form.style.display === 'block';
    form.style.display = isOpen ? 'none' : 'block';
    document.getElementById('registerToggleBtn').textContent = isOpen ? '+ New card' : '– Cancel';
    document.getElementById('registerStatusMsg').className = 'status-msg';
  }

  // ---- CREATE ----
  function registerCard() {
    const uid = document.getElementById('regUid').value.trim().toUpperCase();
    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const balance = parseFloat(document.getElementById('regBalance').value) || 0;

    if (!uid) { showRegisterStatus('error', 'Card UID is required.'); return; }
    if (!name) { showRegisterStatus('error', 'Name is required.'); return; }

    db.ref('users/' + uid).once('value').then((snap) => {
      if (snap.exists()) {
        showRegisterStatus('error', 'A card with UID ' + uid + ' is already registered. Use Edit instead.');
        return;
      }

      const newUser = { name: name, phone: phone, balance: balance, status: 'active' };
      const updates = {};
      updates['users/' + uid] = newUser;
      updates['registered_uids/' + uid] = true; // public existence flag used by the reload page

      db.ref().update(updates).then(() => {
        if (balance > 0) {
          db.ref('users/' + uid + '/transactions').push({
            amount: balance,
            balanceAfter: balance,
            type: 'reload',
            method: 'registration',
            timestamp: Date.now(),
          }).catch((err) => showRegisterStatus('error',
            'Card saved but the opening-balance receipt failed: ' + err.message));
        }
        showRegisterStatus('success', 'Card ' + uid + ' registered successfully.');
        document.getElementById('regUid').value = '';
        document.getElementById('regName').value = '';
        document.getElementById('regPhone').value = '';
        document.getElementById('regBalance').value = '';
      }).catch((err) => showRegisterStatus('error', 'Registration failed: ' + err.message));
    });
  }

  // ---- READ ----
  function renderUsersTable() {
    const filter = (document.getElementById('userFilterInput').value || '').trim().toLowerCase();
    const body = document.getElementById('usersBody');
    const empty = document.getElementById('usersEmpty');
    body.innerHTML = '';

    const entries = Object.entries(allUsersCache).filter(([uid, u]) => {
      if (!filter) return true;
      return uid.toLowerCase().includes(filter) ||
             (u.name || '').toLowerCase().includes(filter) ||
             (u.phone || '').toLowerCase().includes(filter);
    }).sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

    if (entries.length === 0) {
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    entries.forEach(([uid, u]) => {
      const status = u.status || 'active';
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="mono">${uid}</td>
        <td class="prose">${u.name || '—'}</td>
        <td class="prose">${u.phone || '—'}</td>
        <td class="mono">₱${(u.balance || 0).toFixed(2)}</td>
        <td><span class="status-pill ${status === 'active' ? 'active' : 'blocked'}">${status.charAt(0).toUpperCase() + status.slice(1)}</span></td>
        <td class="prose">
          <button class="btn-secondary btn-small" onclick="openEditModal('${uid}')">Edit</button>
          <button class="btn-reject btn-small" onclick="openDeleteModal('${uid}')">Delete</button>
        </td>
      `;
      body.appendChild(row);
    });
  }

  document.getElementById('userFilterInput').addEventListener('input', renderUsersTable);

  // ---- UPDATE ----
  let editStatusValue = 'active';

  function setEditStatus(status) {
    editStatusValue = status;
    document.getElementById('editStatusActiveBtn').classList.toggle('selected', status === 'active');
    document.getElementById('editStatusBlockedBtn').classList.toggle('selected', status === 'blocked');
  }

  function openEditModal(uid) {
    const u = allUsersCache[uid] || {};
    document.getElementById('editUid').value = uid;
    document.getElementById('editName').value = u.name || '';
    document.getElementById('editPhone').value = u.phone || '';
    setEditStatus(u.status || 'active');
    document.getElementById('editStatusMsg').className = 'status-msg';
    document.getElementById('editModalOverlay').classList.add('show');
  }

  function closeEditModal() {
    document.getElementById('editModalOverlay').classList.remove('show');
  }

  function saveEditUser() {
    const uid = document.getElementById('editUid').value;
    const name = document.getElementById('editName').value.trim();
    const phone = document.getElementById('editPhone').value.trim();
    const msgEl = document.getElementById('editStatusMsg');

    if (!name) {
      msgEl.textContent = 'Name is required.';
      msgEl.className = 'status-msg show error';
      return;
    }

    db.ref('users/' + uid).update({
      name: name,
      phone: phone,
      status: editStatusValue,
    }).then(() => {
      closeEditModal();
    }).catch((err) => {
      msgEl.textContent = 'Save failed: ' + err.message;
      msgEl.className = 'status-msg show error';
    });
  }

  // ---- DELETE ----
  let deleteTargetUidValue = null;

  function openDeleteModal(uid) {
    deleteTargetUidValue = uid;
    document.getElementById('deleteTargetUid').textContent = uid;
    document.getElementById('deleteModalOverlay').classList.add('show');
  }

  function closeDeleteModal() {
    deleteTargetUidValue = null;
    document.getElementById('deleteModalOverlay').classList.remove('show');
  }

  function confirmDeleteUser() {
    if (!deleteTargetUidValue) return;
    const updates = {};
    updates['users/' + deleteTargetUidValue] = null;
    updates['registered_uids/' + deleteTargetUidValue] = null;

    db.ref().update(updates).then(() => {
      closeDeleteModal();
    }).catch((err) => {
      alert('Delete failed: ' + err.message);
    });
  }

  // ================================================================
  // ============ TAB 4: STATION (Gentai built-in BMS) =============
  // ================================================================
  // Data path: Gentai BMS --BLE--> ESP32 --REST--> Firebase `battery/`
  //
  // The BMS reports only: pack voltage, SOC %, rated Ah, remaining Ah,
  // and the four cell voltages. Everything else on this panel is derived
  // here from those numbers, and is labelled as such on the page.
  // `updatedAt` is a Firebase SERVER timestamp in ms, so it is safe to
  // compare against the browser clock to detect a dead station.
  const BATT_STALE_MS = 30000;
  const CELL_EMPTY_V  = 2.50;    // LiFePO4 per-cell floor, for the cell bars
  const CELL_FULL_V   = 3.65;    // per-cell ceiling
  const CELL_SPREAD_LIMIT = 0.050;  // above this the pack counts as drifting

  function battText(id, value) {
    document.getElementById(id).textContent = value;
  }

  function battChip(id, label, isOn) {
    const el = document.getElementById(id);
    el.textContent = label + (isOn ? ' ON' : ' OFF');
    el.className = 'batt-chip ' + (isOn ? 'on' : 'off');
  }

  function setStationBadge(show) {
    document.getElementById('stationBadge').style.display = show ? 'inline-block' : 'none';
  }

  function renderCells(cells, lowest, spread) {
    for (let i = 0; i < 4; i++) {
      const v = cells[i];
      const valEl = document.getElementById('cellVolt' + (i + 1));
      const barEl = document.getElementById('cellBar' + (i + 1));

      if (!v) {
        valEl.textContent = '\u2014';
        valEl.className = 'batt-cell-value';
        barEl.style.width = '0%';
        continue;
      }

      valEl.textContent = v.toFixed(3) + ' V';
      // Flag the weakest cell only when the pack is actually drifting
      const isWeak = (spread > CELL_SPREAD_LIMIT && v === lowest);
      valEl.className = 'batt-cell-value ' + (isWeak ? 'neg' : 'pos');

      const fill = ((v - CELL_EMPTY_V) / (CELL_FULL_V - CELL_EMPTY_V)) * 100;
      barEl.style.width = Math.max(0, Math.min(100, fill)) + '%';
      barEl.style.background = isWeak ? 'var(--amber)' : 'var(--green)';
    }
  }

  function renderBattery(b) {
    const offlineBox = document.getElementById('battOffline');

    if (!b) {
      offlineBox.classList.add('show');
      battText('battUpdated', 'No battery data in the database yet.');
      setStationBadge(true);
      return;
    }

    const stale = b.updatedAt && (Date.now() - b.updatedAt > BATT_STALE_MS);
    const down  = (b.online === false) || stale;
    offlineBox.classList.toggle('show', down);

    // ---- cell voltages: the only per-cell data the Gentai packet carries ----
    const cells = [b.cell1, b.cell2, b.cell3, b.cell4].map((v) => Number(v) || 0);
    const live  = cells.filter((v) => v > 0);
    const high  = live.length ? Math.max.apply(null, live) : 0;
    const low   = live.length ? Math.min.apply(null, live) : 0;
    const spread = live.length ? (high - low) : 0;
    const avg    = live.length ? live.reduce((a, c) => a + c, 0) / live.length : 0;
    const balanced = live.length > 0 && spread <= CELL_SPREAD_LIMIT;

    const voltage     = Number(b.voltage) || 0;
    const remainingAh = Number(b.remainingAh) || 0;
    const totalAh     = Number(b.totalAh) || 0;

    setStationBadge(down || (live.length > 0 && !balanced));

    const pct = Math.max(0, Math.min(100, Number(b.percent) || 0));
    document.getElementById('battPercent').innerHTML = pct + '<small>%</small>';

    const gauge = document.getElementById('battGauge');
    gauge.style.width = pct + '%';
    gauge.style.background = pct > 50 ? 'var(--green)'
                           : pct > 20 ? 'var(--amber)'
                           : 'var(--red)';

    // No shunt and no current field in the packet, so charge direction is
    // unknown — report stored charge instead of a flow rate.
    battText('battFlow', totalAh > 0
      ? remainingAh.toFixed(1) + ' Ah remaining of ' + totalAh + ' Ah rated'
      : remainingAh.toFixed(1) + ' Ah remaining');

    battText('battVolt',    voltage.toFixed(2) + ' V');
    battText('battAh',      remainingAh.toFixed(1) + ' Ah');
    battText('battTotalAh', totalAh > 0 ? totalAh + ' Ah' : '\u2014');
    battText('battWh',      (remainingAh * voltage).toFixed(0) + ' Wh');
    battText('battDelta',   live.length ? spread.toFixed(3) + ' V' : '\u2014');
    battText('battAvgCell', live.length ? avg.toFixed(3) + ' V' : '\u2014');

    renderCells(cells, low, spread);

    // Derived status — the Gentai packet has no health byte.
    const healthEl = document.getElementById('battHealth');
    healthEl.textContent = down ? 'Offline' : !live.length ? '\u2014' : balanced ? 'Normal' : 'Check cells';
    healthEl.className = 'status-pill ' + ((!down && balanced && live.length) ? 'active' : 'blocked');

    battChip('battLink', 'Bluetooth link', !down);

    const balEl = document.getElementById('battBalance');
    balEl.textContent = !live.length ? 'Cells \u2014' : balanced ? 'Cells balanced' : 'Cells drifting';
    balEl.className = 'batt-chip ' + (balanced && live.length ? 'on' : 'off');

    battText('battUpdated', b.updatedAt
      ? 'Last update ' + new Date(b.updatedAt).toLocaleTimeString() + (stale ? '  (stale)' : '')
      : 'Waiting for a timestamp\u2026');
  }

  // ================================================================
  // ============ TAB 5: AUTHORIZED RELOADERS (CRUD) ===============
  // ================================================================
  // Data model:
  //   reloaders/{authUid} = { name, email, balance, status, createdAt,
  //                           sales_history: {...}, fund_history: {...} }
  //
  // Database rules give this node admin-only write; a booth may only move
  // its own `balance` and append its own `sales_history`. Everything below
  // therefore runs as the signed-in admin.
  function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function showReloaderStatus(kind, msg) {
    const el = document.getElementById('reloaderStatusMsg');
    el.textContent = msg;
    el.className = 'status-msg show ' + kind;
  }

  function toggleReloaderForm(forceOpen=false) {
    const form = document.getElementById('reloaderForm');
    const opening = forceOpen || form.style.display !== 'block';
    form.style.display = opening ? 'block' : 'none';
    document.getElementById('reloaderToggleBtn').textContent = opening ? '– Close registration' : '+ Register branch & reloader';
    if (opening) {
      registrationModeChanged();
      form.scrollIntoView({behavior:'smooth',block:'nearest'});
    }
  }
  function registrationModeChanged() {
    const fresh=document.getElementById('regBranchModeNew').checked;
    document.getElementById('registerNewBranchWrap').style.display=fresh?'block':'none';
    document.getElementById('registerExistingBranchWrap').style.display=fresh?'none':'block';
    document.getElementById('createReloaderBtn').textContent=fresh?'Create branch & reloader':'Add reloader to branch';
  }

  // ---- PERMANENT BRANCH REGISTRY ----
  // A Firebase push ID identifies the physical location permanently. The
  // operator's Firebase Authentication UID is separate and may be replaced.
  function branchLabel(branchUid) {
    const b = allBranchesCache[branchUid];
    return b ? String(b.name || branchUid) : (branchUid ? 'Unknown branch' : 'Unassigned (legacy)');
  }
  function safeReloaderHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function showBranchStatus(kind,message) {
    const el=document.getElementById('branchStatusMsg');
    el.textContent=message;
    el.className='status-msg show '+kind;
  }
  // Empty default forces the administrator to explicitly select a location.
  function fillBranchSelect(select, allowUnassigned=false) {
    const old=select.value;
    select.replaceChildren();
    select.add(new Option(allowUnassigned ? 'Unassigned (legacy account)' : '— Select an existing physical branch —', ''));
    Object.entries(allBranchesCache)
      .sort((a,b)=>String(a[1].name||a[0]).localeCompare(String(b[1].name||b[0])))
      .forEach(([id,b]) => {
        const opt=new Option((b.name||id)+'  ·  '+id,id);
        if(b.status!=='active') opt.disabled=true;
        select.add(opt);
      });
    // Retain a choice only if it was explicitly selected previously.
    select.value=Array.from(select.options).some(opt=>opt.value===old) ? old : '';
    if(!Object.keys(allBranchesCache).length && !allowUnassigned) {
      select.options[0].textContent='Register a branch and reloader above first';
    }
  }
  function refreshReloaderBranchSelectors() {
    fillBranchSelect(document.getElementById('newReloaderBranch'),false);
    const edit=document.getElementById('editReloaderBranch');
    if (document.getElementById('editReloaderOverlay').classList.contains('show')) {
      const old=edit.value;
      fillBranchSelect(edit,true);
      edit.value=old;
    }
  }
  function branchStartNewReloader(branchUid) {
    if (!branchUid || !allBranchesCache[branchUid] || allBranchesCache[branchUid].status!=='active') {
      showBranchStatus('error','Select a valid active branch.'); return;
    }
    showTab('reloaders');
    document.getElementById('regBranchModeExisting').checked=true;
    toggleReloaderForm(true);
    fillBranchSelect(document.getElementById('newReloaderBranch'), false);
    document.getElementById('newReloaderBranch').value=branchUid;
    document.getElementById('newReloaderName').focus();
  }
  function renderBranchesTable() {
    const tbody=document.getElementById('branchesBody');
    const empty=document.getElementById('branchesEmpty');
    const filter=String(document.getElementById('branchFilterInput').value || '').trim().toLowerCase();
    tbody.replaceChildren();
    const entries=Object.entries(allBranchesCache)
      .filter(([id,b])=> !filter || id.toLowerCase().includes(filter) || String(b.name||'').toLowerCase().includes(filter))
      .sort((a,b)=>String(a[1].name||a[0]).localeCompare(String(b[1].name||b[0])));
    empty.textContent=filter?'No matching branches.':'No branches yet. Register the first branch and reloader above.';
    empty.style.display=entries.length?'none':'block';
    entries.forEach(([id,b])=>{
      const count=Object.values(allReloadersCache).filter(r=>r && r.branchUid===id).length;
      const tr=document.createElement('tr');
      for(const value of [id,b.name||'Unnamed branch',String(count),count===0?'Needs reloader':(b.status||'active')]) {
        const td=document.createElement('td');td.textContent=value;
        if(value===id) {td.className='branch-identifier';td.title='Permanent Branch UID';}
        tr.appendChild(td);
      }
      const cell=document.createElement('td');cell.className='branch-actions';
      const addAction=(label,klass,cb)=>{
        const btn=document.createElement('button');
        btn.type='button';btn.className=klass;btn.textContent=label;
        btn.addEventListener('click',cb);cell.appendChild(btn);return btn;
      };
      const register=addAction('Register operator','btn-secondary btn-small',()=>branchStartNewReloader(id));
      register.disabled=b.status!=='active';
      addAction('Edit','btn-secondary btn-small',()=>openEditBranchModal(id));
      addAction('Delete','btn-reject',()=>openDeleteBranchModal(id));
      tr.appendChild(cell);tbody.appendChild(tr);
    });
  }
  function validateBranchName(name, excludeUid='') {
    if(!name || name.length>100) throw new Error('Enter a branch name (maximum 100 characters).');
    const duplicate=Object.entries(allBranchesCache).some(([id,b])=>id!==excludeUid && String(b.name||'').trim().toLowerCase()===name.toLowerCase());
    if(duplicate) throw new Error('That branch already exists. Choose Existing branch to register another operator.');
  }

  function branchModalStatus(id,kind,message) {
    const el=document.getElementById(id);
    el.textContent=message;
    el.className='status-msg show '+kind;
  }
  function openEditBranchModal(branchUid) {
    const b=allBranchesCache[branchUid];
    if(!reportAdminVerified || !branchesLoaded || !b) {showBranchStatus('error','Choose an existing branch while signed in as a Super Admin.');return;}
    document.getElementById('editBranchUid').value=branchUid;
    document.getElementById('editBranchUidDisplay').textContent=branchUid;
    document.getElementById('editBranchName').value=b.name||'';
    document.getElementById('editBranchStatusMsg').className='status-msg';
    document.getElementById('editBranchOverlay').classList.add('show');
    document.getElementById('editBranchName').focus();
  }
  function closeEditBranchModal() { document.getElementById('editBranchOverlay').classList.remove('show'); }
  async function saveBranchName() {
    const id=document.getElementById('editBranchUid').value;
    const name=document.getElementById('editBranchName').value.trim();
    const button=document.getElementById('saveBranchBtn');
    if(!reportAdminVerified || !auth.currentUser || !allBranchesCache[id]) {
      branchModalStatus('editBranchStatusMsg','error','Branch is missing or Super Admin session ended.');return;
    }
    try {
      validateBranchName(name,id);
      if(name===allBranchesCache[id].name) {closeEditBranchModal();return;}
      button.disabled=true;
      // Update just the display name: preserve permanent ID and registration metadata.
      const latest=await db.ref('branches/'+id).once('value');
      if(!latest.exists()) throw new Error('This branch was deleted or moved.');
      // Prevent overwriting another branch if it has been renamed since the list refreshed.
      const list=await db.ref('branches').once('value');
      if(Object.entries(list.val()||{}).some(([key,b])=>key!==id && String(b.name||'').trim().toLowerCase()===name.toLowerCase()))
        throw new Error('A branch already has this name.');
      await db.ref('branches/'+id+'/name').set(name);
      closeEditBranchModal();
      showBranchStatus('success','Updated branch name to "'+name+'". The permanent Branch UID '+id+' did not change.');
    } catch(err) {branchModalStatus('editBranchStatusMsg','error','Could not rename branch: '+err.message);}
    finally {button.disabled=false;}
  }

  let branchDeleteAllowed=false;
  let branchDeleteToken=0;
  function branchRefreshDeleteButton() {
    const id=document.getElementById('deleteBranchUid').value;
    const typed=document.getElementById('deleteBranchConfirmInput').value.trim();
    document.getElementById('confirmDeleteBranchBtn').disabled=!branchDeleteAllowed || typed!==id;
  }
  // Recheck actual Firebase records, not just rendered UI caches. Only scan
  // fields that explicitly identify a branch. Untagged legacy records cannot
  // be assigned to a location with certainty.
  function branchCountReferences(branchUid,users,reloaders,deviceStatus,deviceLogs) {
    const counts={operators:0,cardTransactions:0,reloaderTransactions:0,devices:0};
    Object.values(reloaders||{}).forEach(r=>{
      if(!r || typeof r!=='object') return;
      if(r.branchUid===branchUid) counts.operators++;
      for(const collection of ['sales_history','fund_history']) {
        Object.values(r[collection]||{}).forEach(t=>{if(t && t.branchUid===branchUid)counts.reloaderTransactions++;});
      }
    });
    Object.values(users||{}).forEach(u=>{
      Object.values((u && u.transactions)||{}).forEach(t=>{if(t && t.branchUid===branchUid)counts.cardTransactions++;});
    });
    // Do not treat an arbitrary free-text mention as branch assignment.
    const countDeviceRefs=(tree)=>{
      if(!tree || typeof tree!=='object')return;
      if(tree.branchUid===branchUid) counts.devices++;
      for(const [k,v] of Object.entries(tree)){
        if(k==='branchUid')continue;
        if(v && typeof v==='object')countDeviceRefs(v);
      }
    };
    countDeviceRefs(deviceStatus);countDeviceRefs(deviceLogs);
    return counts;
  }
  async function branchDeletionPreflight(id) {
    // These are live reads, but client-side checks alone cannot prevent races
    // against concurrent devices/administrators. Harden with server rules.
    const refs=['branches/'+id,'users','reloaders','deviceStatus','deviceLogs'];
    const result=await Promise.all(refs.map(path=>db.ref(path).once('value')));
    if(!result[0].exists()) throw new Error('This branch no longer exists.');
    const data=result.slice(1).map(s=>s.val()||{});
    const counts=branchCountReferences(id,...data);
    const linkedOperators=Object.entries(data[1]).filter(([uid,r])=>r && r.branchUid===id);
    const unsafeOperators=linkedOperators.filter(([uid,r])=>
      Number(r.balance||0)!==0 || Object.keys(r.sales_history||{}).length>0 ||
      Object.keys(r.fund_history||{}).length>0);
    const blockers=counts.cardTransactions+counts.devices+counts.reloaderTransactions+unsafeOperators.length;
    return {counts,blockers,operatorUids:linkedOperators.map(([uid])=>uid),unsafeOperators:unsafeOperators.length};
  }
  async function openDeleteBranchModal(branchUid) {
    const b=allBranchesCache[branchUid];
    if(!reportAdminVerified || !branchesLoaded || !b){showBranchStatus('error','Choose a valid branch with an active Super Admin session.');return;}
    branchDeleteAllowed=false;
    const token=++branchDeleteToken;
    document.getElementById('deleteBranchUid').value=branchUid;
    document.getElementById('deleteBranchUidDisplay').textContent=branchUid;
    document.getElementById('deleteBranchName').textContent='Location: '+(b.name||branchUid);
    document.getElementById('deleteBranchConfirmInput').value='';
    branchModalStatus('deleteBranchStatusMsg','info','Checking live Firebase branch references…');
    branchRefreshDeleteButton();
    document.getElementById('deleteBranchOverlay').classList.add('show');
    try {
      const {counts,blockers}=await branchDeletionPreflight(branchUid);
      if(token!==branchDeleteToken || !document.getElementById('deleteBranchOverlay').classList.contains('show'))return;
      if(blockers) {
        branchModalStatus('deleteBranchStatusMsg','error',
          'Deletion blocked: '+counts.cardTransactions+' tagged card transaction(s), '+
          counts.reloaderTransactions+' tagged reloader record(s), '+counts.devices+
          ' device reference(s), and '+(await branchDeletionPreflight(branchUid)).unsafeOperators+
          ' operator(s) with balances or history. Preserve these records.');
      } else {
        branchDeleteAllowed=true;
        branchModalStatus('deleteBranchStatusMsg','info',
          'Eligible for deletion: '+counts.operators+' linked unused operator account(s) will be removed with the branch record. You MUST also delete their Auth users in Firebase Authentication afterward. Check devices for offline assignments first.');
      }
    }catch(err){
      if(token!==branchDeleteToken)return;
      branchModalStatus('deleteBranchStatusMsg','error','Deletion cannot proceed because reference checks failed: '+err.message);
    }
    branchRefreshDeleteButton();
  }
  function closeDeleteBranchModal() {
    branchDeleteToken++; branchDeleteAllowed=false;
    document.getElementById('deleteBranchOverlay').classList.remove('show');
    document.getElementById('deleteBranchConfirmInput').value='';
    branchRefreshDeleteButton();
  }
  async function confirmDeleteBranch() {
    const id=document.getElementById('deleteBranchUid').value;
    const button=document.getElementById('confirmDeleteBranchBtn');
    if(!reportAdminVerified || !auth.currentUser || !branchDeleteAllowed || !id || document.getElementById('deleteBranchConfirmInput').value.trim()!==id) return;
    const preflight=await branchDeletionPreflight(id).catch(err=>{
      branchModalStatus('deleteBranchStatusMsg','error','Cannot verify deletion safety: '+err.message);
      return null;
    });
    if(!preflight) return;
    if(preflight.blockers) {
      branchDeleteAllowed=false;
      branchModalStatus('deleteBranchStatusMsg','error','The branch acquired new references. Deletion is now blocked.');
      branchRefreshDeleteButton();return;
    }
    if(!confirm('PERMANENTLY delete branch '+branchLabel(id)+' ('+id+') and '+preflight.operatorUids.length+
      ' linked unused reloader record(s)?\n\nThis cannot be undone. You must separately delete the operators in Firebase Authentication.')) return;
    try {
      button.disabled=true;
      // A final preflight helps reduce accidental loss; backend constraints
      // are required to eliminate races with concurrent changes.
      const {blockers,operatorUids}=await branchDeletionPreflight(id);
      if(blockers) throw new Error('New financial, transaction or device references were detected.');
      const updates={}; updates['branches/'+id]=null;
      operatorUids.forEach(uid=>updates['reloaders/'+uid]=null);
      await db.ref().update(updates); // atomic database removal
      closeDeleteBranchModal();
      showBranchStatus('success','Deleted unused branch '+id+' and '+operatorUids.length+
        ' empty reloader record(s). IMPORTANT: Manually delete these operator Auth UIDs under Firebase Authentication → Users: '+
        (operatorUids.join(', ')||'none')+'.');
    }catch(err){
      branchDeleteAllowed=false;
      branchModalStatus('deleteBranchStatusMsg','error','Branch was not deleted: '+err.message);
    }finally {branchRefreshDeleteButton();}
  }

  // ---- CREATE ----
  // createUserWithEmailAndPassword() signs in as the account it just made.
  // A second, named Firebase app keeps that away from the admin's own
  // session, so the console does not log itself out mid-registration.
  let reloaderAuthApp = null;
  function reloaderCreatorAuth() {
    if (!reloaderAuthApp) {
      reloaderAuthApp = firebase.initializeApp(firebaseConfig, 'reloaderCreator');
    }
    return reloaderAuthApp.auth();
  }

  // This form creates Auth first, then writes the branch and reloader together
  // in ONE atomic Realtime Database multi-location update. No branch-only path.
  async function createReloader() {
    const isNew=document.getElementById('regBranchModeNew').checked;
    const branchName=document.getElementById('newBranchName').value.trim();
    const selectedBranch=document.getElementById('newReloaderBranch').value;
    const name=document.getElementById('newReloaderName').value.trim();
    const email=document.getElementById('newReloaderEmail').value.trim();
    const pass=document.getElementById('newReloaderPass').value;
    const rawBalance=document.getElementById('newReloaderBalance').value;
    const balance=r2(rawBalance===''?0:Number(rawBalance));
    const button=document.getElementById('createReloaderBtn');
    if(!reportAdminVerified || !auth.currentUser || !branchesLoaded || !reportReloadersLoaded) {
      showReloaderStatus('error','Wait for the branch/reloader registry to load and verify Super Admin access.'); return;
    }
    try {
      if(isNew) validateBranchName(branchName);
      else if(!selectedBranch || !allBranchesCache[selectedBranch] || allBranchesCache[selectedBranch].status!=='active')
        throw new Error('Select an active registered branch.');
      if(!name || name.length>100) throw new Error('Enter an operator name (up to 100 characters).');
      if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid sign-in email.');
      if(!pass || pass.length<6) throw new Error('Password must contain at least 6 characters.');
      if(!Number.isFinite(Number(rawBalance||0)) || balance<0) throw new Error('Enter a valid nonnegative wallet amount.');
    } catch(err) {showReloaderStatus('error',err.message);return;}
    const intended=isNew?'a NEW branch "'+branchName+'"':'the EXISTING branch "'+branchLabel(selectedBranch)+'"';
    if(!confirm('Create reloader "'+name+'" at '+intended+'?\n\nBranch identity is permanent. The two database records will be linked together.')) return;
    button.disabled=true;
    const secondary=reloaderCreatorAuth();
    let createdUid=null, newBranchUid=null, dbSuccess=false;
    try {
      showReloaderStatus('info','Validating branch registration…');
      const branchSnap=await db.ref('branches').once('value');
      const liveBranches=branchSnap.val()||{};
      if(isNew) {
        if(Object.values(liveBranches).some(b=>String((b||{}).name||'').trim().toLowerCase()===branchName.toLowerCase()))
          throw new Error('This branch already exists. Choose Existing branch instead.');
        newBranchUid=db.ref('branches').push().key; // Generate key; DO NOT write orphan branch.
      } else if(!liveBranches[selectedBranch] || liveBranches[selectedBranch].status!=='active') {
        throw new Error('The selected branch is missing or inactive. Refresh and select again.');
      }
      const branchUid=isNew?newBranchUid:selectedBranch;
      showReloaderStatus('info','Creating operator login…');
      // Secondary Auth session prevents signing out the Super Admin.
      const credential=await secondary.createUserWithEmailAndPassword(email,pass);
      createdUid=credential.user.uid;
      const when=firebase.database.ServerValue.TIMESTAMP;
      const updates={};
      if(isNew) updates['branches/'+branchUid]={
        name:branchName,status:'active',createdAt:when,createdBy:auth.currentUser.uid
      };
      updates['reloaders/'+createdUid]={
        name,email,balance,status:'active',createdAt:when,branchUid,branchAssignedAt:when
      };
      showReloaderStatus('info','Saving linked Firebase records…');
      // Atomic within RTDB: both database records are committed or neither is.
      await db.ref().update(updates);
      dbSuccess=true;
      showReloaderStatus('success',(isNew?'New branch and first reloader':'Additional reloader')+
        ' registered. Branch: '+(isNew?branchName:branchLabel(branchUid))+'. Branch UID: '+branchUid+
        '. Operator Auth UID: '+createdUid+'. Share the password securely.');
      for(const id of ['newBranchName','newReloaderName','newReloaderEmail','newReloaderPass','newReloaderBalance'])
        document.getElementById(id).value='';
      document.getElementById('newReloaderBranch').value='';
      // Subsequent registrations must intentionally select their branch mode.
      document.getElementById('regBranchModeNew').checked=true;
      registrationModeChanged();
    } catch(err) {
      let recovery='';
      if(createdUid && !dbSuccess) {
        // Avoid deleting Auth credentials if RTDB succeeded but response was lost.
        let certainMissing=false;
        try {
          const check=await db.ref('reloaders/'+createdUid).once('value');
          if(check.exists()) {
            recovery=' Firebase record exists; check the console before retrying to avoid duplication.';
          } else certainMissing=true;
        } catch(_) {recovery=' Could not verify the Firebase write. Inspect Authentication and Database before retrying.';}
        if(certainMissing) {
          try {await secondary.currentUser.delete();recovery=' Incomplete login was cleaned up automatically.';}
          catch(cleanErr) {recovery=' Authentication account '+createdUid+' may remain: delete it manually in Firebase Authentication before retrying.';}
        }
      }
      showReloaderStatus('error','Registration failed: '+(err?.message||err)+'.'+recovery);
    } finally {
      try {await secondary.signOut();}catch(_){}
      button.disabled=false;
    }
  }

  // ---- READ ----
  function renderReloadersTable() {
    const filter = (document.getElementById('reloaderFilterInput').value || '').toLowerCase().trim();
    const body   = document.getElementById('reloadersBody');
    const empty  = document.getElementById('reloadersEmpty');
    const foot   = document.getElementById('reloadersFoot');
    body.innerHTML = '';

    let entries = Object.entries(allReloadersCache);
    if (filter) {
      entries = entries.filter(([uid, r]) =>
        uid.toLowerCase().includes(filter) ||
        (r.name || '').toLowerCase().includes(filter) ||
        (r.email || '').toLowerCase().includes(filter) ||
        String(r.branchUid || '').toLowerCase().includes(filter) ||
        branchLabel(r.branchUid).toLowerCase().includes(filter)
      );
    }
    entries.sort((a, b) => (a[1].name || '').localeCompare(b[1].name || ''));

    if (entries.length === 0) {
      empty.style.display = 'block';
      foot.textContent = '';
      return;
    }
    empty.style.display = 'none';

    let totalFloat = 0;
    entries.forEach(([uid, r]) => {
      const status = r.status || 'active';
      const balance = Number(r.balance) || 0;
      totalFloat += balance;

      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="mono" style="max-width:150px; overflow:hidden; text-overflow:ellipsis;" title="${safeReloaderHtml(uid)}">${safeReloaderHtml(uid)}</td>
        <td class="prose">${safeReloaderHtml(r.name || '—')}</td>
        <td class="prose">${safeReloaderHtml(branchLabel(r.branchUid))}<div class="branch-identifier" title="Permanent Branch UID">${safeReloaderHtml(r.branchUid || '—')}</div></td>
        <td class="prose">${safeReloaderHtml(r.email || '—')}</td>
        <td class="mono" style="color:var(--amber); font-weight:700;">₱${balance.toFixed(2)}</td>
        <td><span class="status-pill ${status === 'active' ? 'active' : 'blocked'}">${status.charAt(0).toUpperCase() + status.slice(1)}</span></td>
        <td class="prose" style="white-space:nowrap;">
          <button class="btn-approve btn-small" onclick="openFundModal('${uid}')">Fund</button>
          <button class="btn-secondary btn-small" onclick="openEditReloaderModal('${uid}')">Edit</button>
          <button class="btn-reject btn-small" onclick="openDeleteReloaderModal('${uid}')">Revoke</button>
        </td>
      `;
      body.appendChild(row);
    });

    foot.innerHTML = entries.length + ' reloader' + (entries.length === 1 ? '' : 's') +
                     ' holding <b style="color:var(--text);">₱' + totalFloat.toFixed(2) +
                     '</b> in unsold wallet float.';
  }

  document.getElementById('reloaderFilterInput').addEventListener('input', renderReloadersTable);

  // ---- UPDATE: name + status ----
  let editReloaderStatusValue = 'active';

  function setReloaderStatus(status) {
    editReloaderStatusValue = status;
    document.getElementById('editReloaderActiveBtn').classList.toggle('selected', status === 'active');
    document.getElementById('editReloaderBlockedBtn').classList.toggle('selected', status === 'blocked');
  }

  function openEditReloaderModal(uid) {
    const r = allReloadersCache[uid] || {};
    document.getElementById('editReloaderUid').value = uid;
    document.getElementById('editReloaderName').value = r.name || '';
    document.getElementById('editReloaderEmail').value = r.email || '—';
    const branchSelect=document.getElementById('editReloaderBranch');
    fillBranchSelect(branchSelect,true);
    branchSelect.value=r.branchUid||'';
    if(r.branchUid && !allBranchesCache[r.branchUid]) {
      branchSelect.add(new Option('Unknown existing assignment: '+r.branchUid,r.branchUid));
      branchSelect.value=r.branchUid;
    }
    setReloaderStatus(r.status || 'active');
    document.getElementById('editReloaderStatusMsg').className = 'status-msg';
    document.getElementById('editReloaderOverlay').classList.add('show');
  }

  function closeEditReloaderModal() {
    document.getElementById('editReloaderOverlay').classList.remove('show');
  }

  function saveEditReloader() {
    const uid   = document.getElementById('editReloaderUid').value;
    const name  = document.getElementById('editReloaderName').value.trim();
    const msgEl = document.getElementById('editReloaderStatusMsg');

    if (!name) {
      msgEl.textContent = 'Booth name is required.';
      msgEl.className = 'status-msg show error';
      return;
    }

    const oldBranch=(allReloadersCache[uid]||{}).branchUid||'';
    const newBranch=document.getElementById('editReloaderBranch').value;
    if(newBranch && !allBranchesCache[newBranch] && newBranch!==oldBranch) {
      msgEl.textContent='Select a registered physical branch.';
      msgEl.className='status-msg show error'; return;
    }
    if(newBranch!==oldBranch) {
      if(oldBranch && Object.entries(allReloadersCache).filter(([id,r])=>id!==uid && r && r.branchUid===oldBranch).length===0) {
        msgEl.textContent='This is the last reloader at '+branchLabel(oldBranch)+'. Create a replacement reloader at that branch before moving this operator.';
        msgEl.className='status-msg show error';return;
      }
      const oldLabel=branchLabel(oldBranch);
      const newLabel=branchLabel(newBranch);
      if(!confirm('Change the physical branch for "'+name+'"?\n\nFROM: '+oldLabel+'\nTO: '+newLabel+'\n\nHistorical transactions will retain their recorded branchUid. Continue?')) return;
    }
    // Balance is deliberately not written here — it only moves through
    // Fund (admin) or a transfer at the terminal (reloader).
    const updates={name:name,status:editReloaderStatusValue};
    if(newBranch!==oldBranch) { updates.branchUid=newBranch || null; updates.branchAssignedAt=firebase.database.ServerValue.TIMESTAMP; }
    db.ref('reloaders/' + uid).update(updates).then(() => {
      closeEditReloaderModal();
      showReloaderStatus('success', 'Updated ' + name + '.');
    }).catch((err) => {
      msgEl.textContent = 'Save failed: ' + err.message;
      msgEl.className = 'status-msg show error';
    });
  }

  // ---- UPDATE: wallet float ----
  function openFundModal(uid) {
    const r = allReloadersCache[uid] || {};
    document.getElementById('fundReloaderUid').value = uid;
    document.getElementById('fundReloaderName').textContent = r.name || uid;
    document.getElementById('fundCurrentBalance').textContent = (Number(r.balance) || 0).toFixed(2);
    document.getElementById('fundAmount').value = '';
    document.getElementById('fundStatusMsg').className = 'status-msg';
    document.getElementById('fundReloaderOverlay').classList.add('show');
  }

  function closeFundModal() {
    document.getElementById('fundReloaderOverlay').classList.remove('show');
  }

  function setFundAmount(value) {
    const el = document.getElementById('fundAmount');
    el.value = r2((parseFloat(el.value) || 0) + value);
  }

  function confirmFundReloader() {
    const uid    = document.getElementById('fundReloaderUid').value;
    const amount = r2(parseFloat(document.getElementById('fundAmount').value));
    const msgEl  = document.getElementById('fundStatusMsg');
    const btn    = document.getElementById('fundConfirmBtn');

    if (!amount || !isFinite(amount) || amount === 0) {
      msgEl.textContent = 'Enter an amount to credit or correct.';
      msgEl.className = 'status-msg show error';
      return;
    }

    btn.disabled = true;

    // transaction() so a concurrent reload at the booth cannot be overwritten
    db.ref('reloaders/' + uid + '/balance').transaction((current) => {
      const next = r2((Number(current) || 0) + amount);
      if (next < 0) return;              // abort: rules reject a negative wallet too
      return next;
    }).then((result) => {
      if (!result.committed) {
        throw new Error('That correction would take the wallet below ₱0.');
      }
      const newBalance = Number(result.snapshot.val()) || 0;

      db.ref('reloaders/' + uid + '/fund_history').push({
        amount: amount,
        balanceAfter: newBalance,
        type: amount > 0 ? 'float_issued' : 'correction',
        adminUid: auth.currentUser ? auth.currentUser.uid : null,
        timestamp: Date.now(),
      }).catch((err) => showReloaderStatus('error',
        'Wallet was funded but the audit record failed to save: ' + err.message));

      closeFundModal();
      const verb = amount > 0 ? 'Credited ₱' + amount.toFixed(2) + ' to ' : 'Corrected ₱' + Math.abs(amount).toFixed(2) + ' from ';
      showReloaderStatus('success', verb + (allReloadersCache[uid] || {}).name + '. Wallet now ₱' + newBalance.toFixed(2) + '.');
    }).catch((err) => {
      msgEl.textContent = err.message;
      msgEl.className = 'status-msg show error';
    }).then(() => {
      btn.disabled = false;
    });
  }

  // ---- DELETE ----
  let deleteReloaderUidValue = null;

  function openDeleteReloaderModal(uid) {
    const r = allReloadersCache[uid] || {};
    deleteReloaderUidValue = uid;
    document.getElementById('deleteReloaderUid').textContent = uid;
    document.getElementById('deleteReloaderBalance').textContent = '₱' + (Number(r.balance) || 0).toFixed(2);
    document.getElementById('deleteReloaderOverlay').classList.add('show');
  }

  function closeDeleteReloaderModal() {
    deleteReloaderUidValue = null;
    document.getElementById('deleteReloaderOverlay').classList.remove('show');
  }

  function confirmDeleteReloader() {
    if (!deleteReloaderUidValue) return;
    const uid = deleteReloaderUidValue;

    // A physical branch must never lose its last linked reloader via this UI.
    const assigned=(allReloadersCache[uid]||{}).branchUid;
    if(assigned && Object.entries(allReloadersCache).filter(([id,r])=>r && r.branchUid===assigned && id!==uid).length===0) {
      closeDeleteReloaderModal();
      showReloaderStatus('error','Cannot remove the last reloader linked to '+branchLabel(assigned)+'. Register a replacement operator first, then revoke this account. Alternatively block its status while retaining historical records.');
      return;
    }
    // Preserve original revoke semantics for other accounts. Historical sales
    // still require proper archival before a permanent revoke.
    db.ref('reloaders/' + uid).remove().then(() => {
      closeDeleteReloaderModal();
      showReloaderStatus('info', 'Reloader '+uid+' revoked; its historical sales were deleted as in the original version. Delete the matching Auth user in Firebase Authentication.');
    }).catch((err) => {
      alert('Revoke failed: ' + err.message);
    });
  }
  // ================================================================
  // ============ TAB 6: SALES REPORTS (READ-ONLY) ==================
  // ================================================================
  // Uses the SAME realtime caches as the existing admin pages; no new
  // Firebase node, index, or database write is required for this feature.
  // Amounts are interpreted as PHP (not centavos), like existing code.
  // Fields verified against Firebase screenshots on 2026-10-27:
  // reloader sales_history: cardUid, customerName, amount, timestamp,
  // cardBalanceAfter, reloaderBalanceAfter; customer charge: amount,
  // durationSeconds, port, timestamp, type: charge. No database writes.
  const REPORT_PHT_OFFSET = 8 * 60 * 60 * 1000; // Philippines: UTC+08 year-round
  const REPORT_MAX_ONSCREEN = 100;
  let reportUsersLoaded = false;
  let reportReloadersLoaded = false;
  let reportCurrent = null;
  const reportPHP = new Intl.NumberFormat('en-PH', {style:'currency',currency:'PHP'});

  function reportEscCSV(value) {
    let s = String(value == null ? '' : value);
    // Avoid spreadsheet formula injection from editable booth or card data.
    if (/^\s*[=+@-]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  function reportPad(n) { return String(n).padStart(2, '0'); }
  function reportPhtDay(timeMs) {
    const d = new Date(timeMs + REPORT_PHT_OFFSET);
    return d.getUTCFullYear() + '-' + reportPad(d.getUTCMonth()+1) + '-' + reportPad(d.getUTCDate());
  }
  function reportPhtTime(timeMs) {
    const d = new Date(timeMs + REPORT_PHT_OFFSET);
    return reportPhtDay(timeMs) + ' ' + reportPad(d.getUTCHours()) + ':' + reportPad(d.getUTCMinutes());
  }
  function reportTimeMs(raw) {
    if (raw && typeof raw === 'object' && typeof raw.seconds === 'number') return raw.seconds*1000 + Math.floor((raw.nanoseconds||0)/1e6);
    if (raw === null || raw === undefined || raw === '') return NaN;
    if (typeof raw === 'string' && !/^\d+(\.\d+)?$/.test(raw.trim())) {
      let s = raw.trim().replace(' ', 'T');
      if (/^\d{4}-\d\d-\d\d$/.test(s)) s += 'T00:00:00+08:00';
      else if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += '+08:00';
      return Date.parse(s);
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    return n < 100000000000 ? n * 1000 : n; // Unix seconds or milliseconds
  }
  function reportDateValue(record) {
    return reportTimeMs(record.timestamp ?? record.paidAt ?? record.completedAt ?? record.createdAt ?? record.date);
  }
  function reportAmount(record) {
    // Both verified Firebase transaction schemas store amounts in PESOS.
    const v = record.amount;
    if (v === undefined || v === null || v === '') return NaN;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n*100)/100 : NaN;
  }
  function reportIsCompleted(record) {
    const s = String(record.status || '').trim().toLowerCase();
    return !['pending','failed','cancelled','canceled','rejected','void','refunded','reversed'].includes(s);
  }
  function reportCollect(source, branchFilter) {
    const records = [];
    let skipped = 0;
    let seenHistory = false;
    if (source === 'charging') {
      Object.entries(allUsersCache).forEach(([uid, user]) => {
        const history = user && user.transactions;
        if (!history || typeof history !== 'object') return;
        seenHistory = true;
        Object.entries(history).forEach(([key, t]) => {
          if (!t || typeof t !== 'object') { skipped++; return; }
          const type = String(t.type || 'charge').toLowerCase();
          // Only actual completed charging sessions are operating revenue.
          // Card top-ups, registration credits and other transactions are not.
          if (type !== 'charge' || !reportIsCompleted(t)) return;
          const amount = reportAmount(t), timestamp = reportDateValue(t);
          if (!Number.isFinite(amount) || !Number.isFinite(timestamp)) { skipped++; return; }
          const parts=[];
          if (t.port !== undefined && t.port !== null && t.port !== '') parts.push('Port '+t.port);
          if (Number.isFinite(Number(t.durationSeconds)) && Number(t.durationSeconds)>=0 && t.durationSeconds !== undefined) parts.push(Number(t.durationSeconds)+' sec');
          records.push({id:key,owner:uid,cardUid:uid,detail:parts.join(' / '),amount,timestamp,
            branchUid:String(t.branchUid || '')});
        });
      });
    } else {
      Object.entries(allReloadersCache).forEach(([uid, booth]) => {
        const history = booth && booth.sales_history;
        if (!history || typeof history !== 'object') return;
        seenHistory = true;
        Object.entries(history).forEach(([key, t]) => {
          if (!t || typeof t !== 'object') { skipped++; return; }
          if (!reportIsCompleted(t)) return;
          const amount = reportAmount(t), timestamp = reportDateValue(t);
          if (!Number.isFinite(amount) || !Number.isFinite(timestamp)) { skipped++; return; }
          records.push({id:key,owner:booth.name || uid,cardUid:String(t.cardUid ?? ''),
            detail:String(t.customerName ?? ''),amount,timestamp,ownerUid:uid,
            branchUid:String(t.branchUid || '')});
        });
      });
    }
    return {records,skipped,seenHistory};
  }
  function reportBounds(dayKey, period) {
    const p = dayKey.split('-').map(Number);
    if (p.length !== 3 || !p[0] || p[1]<1 || p[1]>12 || p[2]<1 || p[2]>31) return null;
    let start = Date.UTC(p[0], p[1]-1, p[2]);
    if (period === 'weekly') {
      const day = new Date(start).getUTCDay();
      start -= ((day+6)%7)*86400000;
    }
    if (period === 'monthly') start = Date.UTC(p[0],p[1]-1,1);
    if (period === 'yearly') start = Date.UTC(p[0],0,1);
    const s = new Date(start);
    const end = period === 'daily' ? start+86400000 :
                period === 'weekly' ? start+7*86400000 :
                period === 'monthly' ? Date.UTC(s.getUTCFullYear(), s.getUTCMonth()+1,1) :
                Date.UTC(s.getUTCFullYear()+1,0,1);
    return {start:start-REPORT_PHT_OFFSET,end:end-REPORT_PHT_OFFSET,
            startKey:reportPhtDay(start-REPORT_PHT_OFFSET),endKey:reportPhtDay(end-86400000-REPORT_PHT_OFFSET)};
  }
  function reportBucketKey(ms,period) {
    const shifted = new Date(ms + REPORT_PHT_OFFSET);
    return period === 'daily' ? reportPad(shifted.getUTCHours())+':00' :
           period === 'yearly' ? String(shifted.getUTCFullYear())+'-'+reportPad(shifted.getUTCMonth()+1) :
           reportPhtDay(ms);
  }
  function reportBuckets(bounds,period) {
    const items = [];
    if (period === 'daily') {
      for(let h=0;h<24;h++) items.push({key:reportPad(h)+':00',label:reportPad(h)+':00',amount:0,count:0});
    } else if (period === 'yearly') {
      const y = Number(bounds.startKey.slice(0,4));
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      for(let m=1;m<=12;m++) items.push({key:y+'-'+reportPad(m),label:months[m-1],amount:0,count:0});
    } else {
      const d0 = Date.parse(bounds.startKey+'T00:00:00Z');
      const d1 = Date.parse(bounds.endKey+'T00:00:00Z');
      for(let day=d0;day<=d1;day+=86400000) {
        const key=new Date(day).toISOString().slice(0,10);
        items.push({key,label:period==='monthly'?key.slice(8):key.slice(5),amount:0,count:0});
      }
    }
    return items;
  }
  function reportShowAlert(message) {
    const el = document.getElementById('reportAlert');
    el.textContent = message || '';
    el.classList.toggle('show', !!message);
  }
  function reportToggleExports(on) {
    document.getElementById('reportCsvBtn').disabled = !on;
    document.getElementById('reportXlsxBtn').disabled = !on;
    document.getElementById('reportPdfBtn').disabled = !on;
  }
  function reportPopulateStores() {
    const select=document.getElementById('reportStore');
    const previous=select.value;
    select.replaceChildren(new Option('All branches (including unassigned)',''));
    Object.entries(allBranchesCache)
      .sort((a,b)=>String(a[1].name||a[0]).localeCompare(String(b[1].name||b[0])))
      .forEach(([id,branch])=>select.add(new Option(branch.name||id,id)));
    if(allBranchesCache[previous]) select.value=previous;
  }
  function reportSourceChanged() {
    const reloader=document.getElementById('reportSource').value==='reloader';
    document.getElementById('reportStoreWrap').classList.remove('report-hidden');
    document.getElementById('reportEntitiesLabel').textContent=reloader?'Booths with sales':'Cards with charges';
    document.getElementById('reportOwnerTh').textContent=reloader?'Reloader / booth':'Charging card';
    document.getElementById('reportDetailTh').textContent=reloader?'Customer':'Port / duration';
    document.getElementById('reportExplanation').textContent=reloader ?
      'Branch top-up collections require a branchUid on each sale. Historical records without branchUid remain unassigned.' :
      'Branch charging revenue requires each ESP32 to tag completed charging transactions with its branchUid. Historical untagged charges remain unassigned.';
    renderSalesReport();
  }
  // The Day/Week reference date and Month/Year selectors all describe the
  // same business date. Keeping them synchronized makes exports and charts
  // reflect the exact month/year the administrator has chosen.
  function reportEnsureYearOption(year) {
    const select = document.getElementById('reportYear');
    if (!Array.from(select.options).some(opt => opt.value === String(year))) {
      select.add(new Option(String(year), String(year)));
      // Keep years newest first, including dates outside the default range.
      Array.from(select.options).sort((a,b) => Number(b.value)-Number(a.value))
        .forEach(option => select.add(option));
    }
  }
  function reportSyncCalendarFromDate() {
    const date = document.getElementById('reportDate').value || reportPhtDay(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const year = date.slice(0,4), month = date.slice(5,7);
    reportEnsureYearOption(year);
    document.getElementById('reportYear').value = year;
    document.getElementById('reportMonth').value = month;
  }
  function reportShowPeriodControls() {
    const period = document.getElementById('reportPeriod').value;
    document.getElementById('reportDateWrap').classList.toggle('report-hidden', period==='monthly' || period==='yearly');
    document.getElementById('reportMonthWrap').classList.toggle('report-hidden', period!=='monthly');
    document.getElementById('reportYearWrap').classList.toggle('report-hidden', period!=='monthly' && period!=='yearly');
  }
  function reportPeriodChanged() {
    reportSyncCalendarFromDate();
    reportShowPeriodControls();
    renderSalesReport();
  }
  function reportReferenceDateChanged() {
    reportSyncCalendarFromDate();
    renderSalesReport();
  }
  function reportCalendarChanged() {
    const year = document.getElementById('reportYear').value;
    const month = document.getElementById('reportMonth').value;
    if (!/^\d{4}$/.test(year) || !/^(0[1-9]|1[0-2])$/.test(month)) return;
    // The actual year range is selected below by reportBounds(). Month is
    // retained while the administrator moves between Yearly and Monthly.
    document.getElementById('reportDate').value = year + '-' + month + '-01';
    renderSalesReport();
  }
  function reportSetToday() {
    document.getElementById('reportDate').value = reportPhtDay(Date.now());
    reportSyncCalendarFromDate();
    reportShowPeriodControls();
    renderSalesReport();
  }
  function reportInitCalendarControls() {
    const year = Number(reportPhtDay(Date.now()).slice(0,4));
    const select = document.getElementById('reportYear');
    for (let y = year+5; y >= 2000; y--) select.add(new Option(String(y), String(y)));
    if (!document.getElementById('reportDate').value) {
      document.getElementById('reportDate').value = reportPhtDay(Date.now());
    }
    reportSyncCalendarFromDate();
    reportShowPeriodControls();
  }
  function reportTextRow(tbody, values) {
    const row=document.createElement('tr');
    values.forEach(value => {const td=document.createElement('td'); td.textContent=String(value); row.appendChild(td);});
    tbody.appendChild(row);
  }
  function reportShortPHP(n) {
    return n>=1000000 ? '₱'+(n/1000000).toFixed(1)+'m' :
           n>=1000 ? '₱'+(n/1000).toFixed(1)+'k' : '₱'+Math.round(n);
  }
  function renderSalesReport() {
    if (!document.getElementById('reportDate').value) document.getElementById('reportDate').value=reportPhtDay(Date.now());
    const source=document.getElementById('reportSource').value;
    const period=document.getElementById('reportPeriod').value;
    const year=document.getElementById('reportYear').value;
    const month=document.getElementById('reportMonth').value;
    // Daily and Weekly use the exact reference date; Monthly uses the
    // selected month AND year; Yearly covers January-December of that year.
    const date=period==='yearly' ? year+'-01-01' :
               period==='monthly' ? year+'-'+month+'-01' :
               document.getElementById('reportDate').value;
    const booth=document.getElementById('reportStore').value;
    const loaded= source==='charging' ? reportUsersLoaded : reportReloadersLoaded;
    const bounds=reportBounds(date,period);
    reportCurrent=null;
    reportToggleExports(false);
    if (!reportAdminVerified || !loaded || !bounds) {
      reportShowAlert(!reportAdminVerified ? 'Please sign in as a Super Admin to see reports.' : !loaded ? 'Loading sales records from Firebase…' : 'Select a valid date.');
      return;
    }
    const {records,skipped,seenHistory}=reportCollect(source,booth);
    const inPeriod=records.filter(r=>r.timestamp>=bounds.start && r.timestamp<bounds.end);
    const unassigned=inPeriod.filter(r=>!r.branchUid).length;
    const filtered=inPeriod.filter(r=>!booth || r.branchUid===booth).sort((a,b)=>b.timestamp-a.timestamp);
    const buckets=reportBuckets(bounds,period);
    const map=new Map(buckets.map(b=>[b.key,b]));
    let total=0;
    filtered.forEach(r=>{total+=r.amount;const group=map.get(reportBucketKey(r.timestamp,period));if(group){group.amount+=r.amount;group.count++;}});
    total=Math.round(total*100)/100;
    const unique=new Set(filtered.map(r=>r.ownerUid || r.owner)).size;
    const branchName=booth ? branchLabel(booth) : 'All branches';
    const title=(source==='charging'?'Charging revenue':'Reloader collections')+' · '+branchName+' · '+period.charAt(0).toUpperCase()+period.slice(1)+' · '+bounds.startKey+' to '+bounds.endKey;
    document.getElementById('reportPeriodLabel').textContent=title;
    document.getElementById('reportTotal').textContent=reportPHP.format(total);
    document.getElementById('reportTransactions').textContent=filtered.length.toLocaleString('en-PH');
    document.getElementById('reportAverage').textContent=reportPHP.format(filtered.length?total/filtered.length:0);
    document.getElementById('reportEntities').textContent=unique.toLocaleString('en-PH');
    document.getElementById('reportRowsNote').textContent='Displaying '+Math.min(REPORT_MAX_ONSCREEN,filtered.length)+' of '+filtered.length+' matching transactions. CSV, Excel and PDF contain the entire selected report.';
    const warns=[];
    if (!seenHistory) warns.push(source==='charging' ? 'No card transaction history was found in the loaded database.' : 'No sales_history found for the selected reloader(s). Verify the live Firebase structure.');
    if(skipped) warns.push(skipped+' source record(s) had invalid or missing amount/timestamp and were omitted. Confirm the actual Firebase field names before using these totals as official figures.');
    if(booth && unassigned) warns.push(unassigned+' transaction(s) in this period do not carry branchUid, so branch-specific totals are PARTIAL. Do not treat zero attributed sales as a verified zero. Update your reloader terminal/ESP32 firmware to tag every new event.');
    if(!filtered.length && seenHistory) warns.push(booth ? 'No transactions explicitly attributed to this branch in the selected period.' : 'No matching positive completed transactions in this reporting period.');
    reportShowAlert(warns.join(' '));
    const bars=document.getElementById('reportBars');
    bars.replaceChildren();
    const max=Math.max(...buckets.map(b=>b.amount),0);
    buckets.forEach(b=>{
      const col=document.createElement('div'); col.className='report-bar-col';
      const v=document.createElement('div'); v.className='report-bar-amount'; v.textContent=b.amount?reportShortPHP(b.amount):'';
      const bar=document.createElement('div'); bar.className='report-bar';bar.style.height=(max? Math.max(3,145*b.amount/max):3)+'px';bar.title=b.label+': '+reportPHP.format(b.amount);
      const x=document.createElement('div'); x.className='report-bar-label';x.textContent=b.label;
      col.append(v,bar,x);bars.appendChild(col);
    });
    const breakdown=document.getElementById('reportBreakdownBody');breakdown.replaceChildren();
    buckets.forEach(b=>reportTextRow(breakdown,[b.label,b.count,reportPHP.format(b.amount)]));
    const details=document.getElementById('reportDetailsBody');details.replaceChildren();
    filtered.slice(0,REPORT_MAX_ONSCREEN).forEach(r=>reportTextRow(details,
      [reportPhtTime(r.timestamp),r.owner,r.cardUid||'—',r.detail||'—',r.id,reportPHP.format(r.amount)]));
    reportCurrent={source,period,bounds,booth,branchName,unassigned,rows:filtered,buckets,total,unique,title};
    // Never export a definitive zero for a branch while legacy unassigned
    // records exist in the same period. The origin is unknown, not zero.
    reportToggleExports(seenHistory && !(booth && unassigned>0 && filtered.length===0));
  }
  function reportFilename(extension) {
    const scope=reportCurrent.booth ? '-branch-'+reportCurrent.booth.replace(/[^A-Za-z0-9_-]/g,'_') : '-all-branches';
    return 'tambayan-'+reportCurrent.source+scope+'-'+reportCurrent.period+'-'+reportCurrent.bounds.startKey+'-to-'+reportCurrent.bounds.endKey+'.'+extension;
  }
  // ---------------------------------------------------------------
  // Professional exports. All calculations come from reportCurrent;
  // PDF/CSV never change database records or the dashboard totals.
  // ---------------------------------------------------------------
  function reportExportMoney(amount) {
    return new Intl.NumberFormat('en-PH', {minimumFractionDigits:2,maximumFractionDigits:2}).format(amount);
  }
  function reportExportCategory(r) {
    return r.source==='charging' ? 'Charging revenue' : 'Reloader collections';
  }
  function reportExportDateParts(ms) {
    return reportPhtTime(ms).split(' '); // local PHT YYYY-MM-DD and HH:mm
  }
  function reportDownloadCSV() {
    if(!reportCurrent || !reportAdminVerified) return;
    const r=reportCurrent;
    const avg = r.rows.length ? r.total/r.rows.length : 0;
    const entityTitle = r.source==='charging' ? 'Cards with charges' : 'Booths with sales';
    const columns = r.source==='charging' ?
      ['Date (PHT)','Time (PHT)','Charging card','Card UID','Charging session','Transaction ID','Amount (PHP)'] :
      ['Date (PHT)','Time (PHT)','Reloader / booth','Card UID','Customer','Transaction ID','Amount (PHP)'];
    // Blank rows and section headings are intentional: the exported file
    // remains a readable *report*, rather than a database-only data dump.
    // Amounts remain numeric for Excel / WPS totals and filtering.
    const rows = [
      ['TAMBAYAN','SALES REPORT'],
      ['Sales category',reportExportCategory(r)],
      ['Branch',r.branchName],
      ['Permanent branch UID',r.booth || 'All branches'],
      ['Untagged transactions in period',r.unassigned],
      ['Reporting period',r.period.toUpperCase()],
      ['Period start (PHT)',r.bounds.startKey],
      ['Period end (PHT)',r.bounds.endKey],
      ['Business timezone','Asia/Manila (UTC+08:00)'],
      ['Report generated (PHT)',reportPhtTime(Date.now())],
      ['TOTAL (PHP)',r.total.toFixed(2)],
      ['Transaction count',r.rows.length],
      ['Average transaction (PHP)',avg.toFixed(2)],
      [entityTitle,r.unique],
      ['Accounting note','Do not combine sales categories.'],
      [], ['PERIOD BREAKDOWN'], ['Period','Transactions','Amount (PHP)']
    ];
    r.buckets.forEach(b=>rows.push([(['weekly','monthly','yearly'].includes(r.period) ? b.key : b.label),b.count,b.amount.toFixed(2)]));
    rows.push(['TOTAL',r.rows.length,r.total.toFixed(2)],[],['TRANSACTION DETAILS'],columns);
    r.rows.forEach(tx=>{
      const [day,time]=reportExportDateParts(tx.timestamp);
      rows.push([day,time,tx.owner,tx.cardUid||'',tx.detail||'',tx.id,tx.amount.toFixed(2)]);
    });
    rows.push(['TOTAL','','','','','',r.total.toFixed(2)]);
    // UTF-8 BOM allows Philippine peso labels and customer names to open
    // reliably in common spreadsheet software; CRLF is Excel-friendly.
    const content='\ufeff'+rows.map(row=>row.map(reportEscCSV).join(',')).join('\r\n')+'\r\n';
    const url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8;'}));
    const a=document.createElement('a');
    a.href=url;a.download=reportFilename('csv');
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }


  // ---------------------------------------------------------------
  // Optional, properly formatted Excel (.xlsx) workbook.
  // This produces two sheets in the user's browser and never writes to Firebase.
  // The ExcelJS script is loaded only when the admin requests an Excel download.
  // ---------------------------------------------------------------
  let reportExcelLibraryPromise = null;
  function reportLoadExcelLibrary() {
    if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
    if (reportExcelLibraryPromise) return reportExcelLibraryPromise;
    reportExcelLibraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
      script.onload = () => window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error('ExcelJS is unavailable'));
      script.onerror = () => reject(new Error('Unable to load Excel library. Check internet connection.'));
      document.head.appendChild(script);
    }).catch(err => {
      reportExcelLibraryPromise = null; // allow retry if temporarily offline
      throw err;
    });
    return reportExcelLibraryPromise;
  }

  async function reportDownloadExcel() {
    if (!reportCurrent || !reportAdminVerified) return;
    const button = document.getElementById('reportXlsxBtn');
    button.disabled = true;
    const buttonText = button.textContent;
    button.textContent = 'Preparing Excel…';
    reportShowAlert('Preparing Excel workbook…');
    try {
      const ExcelJS = await reportLoadExcelLibrary();
      // Check after async library loading in case the admin logged out.
      if (!reportAdminVerified || !reportCurrent) return;
      const r = reportCurrent;
      const wb = new ExcelJS.Workbook();
      wb.creator = 'TAMBAYAN Sales Reports';
      wb.title = 'TAMBAYAN Business Sales Report';
      wb.subject = 'Sales reports derived from existing Firebase transactions';
      wb.created = new Date();
      const dark = '182027', header = '273039', orange = 'E8A33D', light = 'F3F6F8', white = 'FFFFFF', muted = '687887';
      const pesoFmt = '"PHP "#,##0.00';
      const category = reportExportCategory(r);
      const entityTitle = r.source === 'charging' ? 'Cards with charges' : 'Booths with sales';
      const applyTitle = (sheet, columns, title, subtitle) => {
        sheet.mergeCells(1,1,2,columns);
        const titleCell = sheet.getCell(1,1);
        titleCell.value = title;
        titleCell.font = {name:'Aptos Display', size:17, bold:true, color:{argb:white}};
        titleCell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:dark}};
        titleCell.alignment = {vertical:'middle', horizontal:'left', indent:1};
        sheet.getRow(1).height = 21;
        sheet.getRow(2).height = 23;
        sheet.mergeCells(3,1,3,columns);
        const sub = sheet.getCell(3,1);
        sub.value = subtitle;
        sub.font = {name:'Aptos', size:10, color:{argb:muted}, bold:true};
        sub.alignment = {vertical:'middle', indent:1};
        sheet.getRow(3).height = 24;
      };
      const styleTableHeader = (row) => {
        row.height = 25;
        row.eachCell(c => {
          c.fill = {type:'pattern', pattern:'solid', fgColor:{argb:header}};
          c.font = {name:'Aptos', size:10, bold:true, color:{argb:white}};
          c.alignment = {vertical:'middle', wrapText:true};
        });
      };
      const styleBody = (row, idx, numericColumns=[]) => {
        row.height = 22;
        row.eachCell({includeEmpty:true}, (cell, col) => {
          cell.font = {name:'Aptos', size:10, color:{argb:dark}};
          if (idx%2===0) cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:light}};
          cell.alignment={vertical:'middle',wrapText:false};
          if(numericColumns.includes(col)) cell.alignment={vertical:'middle',horizontal:'right'};
        });
      };
      const summary=wb.addWorksheet('Summary',{views:[{state:'frozen',ySplit:3}]});
      summary.columns=[{width:28},{width:30},{width:21},{width:21}];
      applyTitle(summary,4,'TAMBAYAN  |  BUSINESS SALES REPORT', category + '  •  ' + r.branchName + '  •  ' + r.period.toUpperCase() + '  •  Asia/Manila (PHT)');
      const info=[
        ['Total amount (PHP)',r.total],
        ['Transactions',r.rows.length],
        ['Average transaction (PHP)',r.rows.length?r.total/r.rows.length:0],
        [entityTitle,r.unique],
        ['Reporting period',r.period.toUpperCase()],
        ['Period start (PHT)',r.bounds.startKey],
        ['Period end (PHT)',r.bounds.endKey],
        ['Generated (PHT)',reportPhtTime(Date.now())]
      ];
      info.forEach((pair,i)=>{
        const rr=summary.getRow(5+i);
        rr.getCell(1).value=pair[0];rr.getCell(2).value=pair[1];rr.height=22;
        rr.getCell(1).font={name:'Aptos',size:10,bold:true,color:{argb:muted}};
        rr.getCell(2).font={name:'Aptos',size:11,bold:i<4,color:{argb:dark}};
        if(i===0||i===2) rr.getCell(2).numFmt=pesoFmt;
        if(i<4) {
          rr.getCell(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:light}};
          rr.getCell(2).fill={type:'pattern',pattern:'solid',fgColor:{argb:light}};
        }
      });
      summary.mergeCells('A14:D15');
      const note=summary.getCell('A14');
      note.value='Branch: '+r.branchName+' (UID: '+(r.booth||'All')+'). Untagged transactions this period: '+r.unassigned+'. Accounting note: charging revenue and top-ups are separate measures; do not add them together.';
      note.alignment={wrapText:true,vertical:'middle',indent:1};
      note.font={name:'Aptos',size:10,color:{argb:muted}};
      note.fill={type:'pattern',pattern:'solid',fgColor:{argb:light}};
      summary.getRow(14).height=22;summary.getRow(15).height=21;
      summary.mergeCells('A17:D17');
      summary.getCell('A17').value='PERIOD BREAKDOWN';
      summary.getCell('A17').font={name:'Aptos Display',size:12,bold:true,color:{argb:dark}};
      const bh=summary.getRow(18);
      bh.values=['Period','Transactions','Amount (PHP)'];
      styleTableHeader(bh);
      r.buckets.forEach((b,i)=>{
        const row=summary.getRow(19+i);
        row.values=[r.period==='yearly'?b.label: b.key,b.count,b.amount];
        row.getCell(3).numFmt=pesoFmt;
        styleBody(row,i,[2,3]);
      });
      const totalRow=summary.getRow(19+r.buckets.length);
      totalRow.values=['TOTAL',r.rows.length,r.total];
      totalRow.getCell(3).numFmt=pesoFmt;
      styleTableHeader(totalRow);
      // Dark-background totals remain numeric and user-editable in Excel.

      const txsheet=wb.addWorksheet('Transactions',{views:[{state:'frozen',ySplit:5}]});
      txsheet.columns=[
        {width:16},{width:12},{width:30},{width:20},{width:32},{width:36},{width:18}
      ];
      applyTitle(txsheet,7,'TAMBAYAN  |  TRANSACTION DETAILS', category+'  •  '+r.branchName+'  •  '+r.bounds.startKey+' to '+r.bounds.endKey+'  •  '+r.rows.length+' records');
      const txHead=txsheet.getRow(5);
      txHead.values=['Date (PHT)','Time (PHT)',r.source==='charging'?'Charging card':'Reloader / booth','Card UID',r.source==='charging'?'Port / duration':'Customer','Transaction ID','Amount (PHP)'];
      styleTableHeader(txHead);
      r.rows.forEach((tx,i)=>{
        const [date,time]=reportExportDateParts(tx.timestamp);
        const row=txsheet.getRow(6+i);
        // The ISO date, card UID, and transaction ID are strings, not formulas.
        // Text preserves leading zeroes and exact Firebase push IDs.
        row.values=[date,time,String(tx.owner||''),String(tx.cardUid||''),String(tx.detail||''),String(tx.id||''),tx.amount];
        row.getCell(7).numFmt=pesoFmt;
        for(let c=1;c<=6;c++) row.getCell(c).numFmt='@';
        styleBody(row,i,[7]);
      });
      if(r.rows.length){
        txsheet.autoFilter={from:{row:5,column:1},to:{row:5+r.rows.length,column:7}};
      }
      const txTotalRow=txsheet.getRow(6+r.rows.length);
      txTotalRow.getCell(1).value='TOTAL';
      txTotalRow.getCell(7).value=r.total;
      txTotalRow.getCell(7).numFmt=pesoFmt;
      styleTableHeader(txTotalRow);
      const bytes=await wb.xlsx.writeBuffer();
      const blob=new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=reportFilename('xlsx');
      document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      reportShowAlert('Excel report downloaded: Summary and Transactions worksheets.');
    } catch(err) {
      console.error('Excel report export failed',err);
      reportShowAlert('Excel export failed: '+(err && err.message || 'Unknown error')+'. PDF and CSV exports are still available.');
    } finally {
      button.textContent=buttonText;
      button.disabled=!reportCurrent||!reportAdminVerified;
    }
  }

  function reportDownloadPDF() {
    if(!reportCurrent || !reportAdminVerified) return;
    if(!window.jspdf || !window.jspdf.jsPDF) {
      reportShowAlert('The PDF library did not load. Check your internet connection; CSV exports remain available.');
      return;
    }
    const r=reportCurrent;
    // A4 landscape: six transaction columns retain usable, legible widths.
    const doc=new window.jspdf.jsPDF({orientation:'landscape',unit:'mm',format:'a4'});
    const pageW=297, pageH=210, left=14, right=283;
    const colors={dark:[24,31,37],dark2:[39,48,57],amber:[232,163,61],
      ink:[29,39,48],muted:[99,112,125],light:[245,247,249],line:[217,225,231],white:[255,255,255]};
    const fill=(rgb)=>doc.setFillColor(...rgb);
    const stroke=(rgb)=>doc.setDrawColor(...rgb);
    const ink=(rgb)=>doc.setTextColor(...rgb);
    const text=(s,x,y,size=9,bold=false,color=colors.ink,opt={})=>{
      doc.setFont('helvetica',bold?'bold':'normal');doc.setFontSize(size);ink(color);
      doc.text(String(s == null ? '' : s),x,y,opt);
    };
    const cash=(n)=>'PHP '+reportExportMoney(n);
    const category=reportExportCategory(r);
    const genAt=reportPhtTime(Date.now())+' PHT';
    const notes=r.source==='charging' ?
      'Charging fees only. Customer card top-ups and operator wallet float are excluded.' :
      'Top-up collections only. Charging revenue and wallet float are excluded.';

    // Page 1 - executive summary and complete period breakdown.
    fill(colors.dark);doc.rect(0,0,pageW,36,'F');
    fill(colors.amber);doc.roundedRect(left,11,13,13,2,2,'F');
    text('T',left+6.5,20.5,16,true,colors.dark,{align:'center'});
    text('TAMBAYAN',left+19,17,16,true,colors.white);
    text('BUSINESS SALES REPORT',left+19,25,9,false,[217,225,231]);
    text(category.toUpperCase(),right,16,13,true,colors.white,{align:'right'});
    text(r.period.toUpperCase()+'  |  '+r.bounds.startKey+' to '+r.bounds.endKey,right,25,9,false,[217,225,231],{align:'right'});

    const summary=[
      ['TOTAL AMOUNT',cash(r.total)],
      ['TRANSACTIONS',String(r.rows.length)],
      ['AVERAGE PER TRANSACTION',cash(r.rows.length?r.total/r.rows.length:0)],
      [r.source==='charging'?'CARDS WITH CHARGES':'BOOTHS WITH SALES',String(r.unique)]
    ];
    const gap=7,boxW=(right-left-3*gap)/4,boxY=44,boxH=28;
    summary.forEach(([label,value],i)=>{
      const x=left+i*(boxW+gap);
      fill(colors.light);stroke(colors.line);
      doc.roundedRect(x,boxY,boxW,boxH,2.5,2.5,'FD');
      text(label,x+4,boxY+8,7.8,true,colors.muted);
      text(value,x+4,boxY+20,15,true,colors.ink);
    });
    text('Business timezone: Asia/Manila (UTC+08:00)',left,80,8,false,colors.muted);
    text('Generated: '+genAt,right,80,8,false,colors.muted,{align:'right'});
    text('Branch: '+r.branchName+(r.booth?' ('+r.booth+')':''),left,84,8,false,colors.muted);
    text(notes,left,89,8,false,colors.muted);
    text('PERIOD BREAKDOWN',left,96,11,true,colors.ink);

    // Two-column summary avoids splitting 24 hourly / 31 daily segments
    // over multiple pages. It stays legible on an A4 landscape printout.
    const half=Math.ceil(r.buckets.length/2);
    const groups=[r.buckets.slice(0,half),r.buckets.slice(half)];
    const tableW=129,tableXs=[left,154],tableY=101,tableHeadH=9,rowH=5.15;
    groups.forEach((entries,side)=>{
      const x=tableXs[side];
      fill(colors.dark2);doc.roundedRect(x,tableY,tableW,tableHeadH,1,1,'F');
      text('PERIOD',x+4,tableY+6,8,true,colors.white);
      text('TXNS',x+93,tableY+6,8,true,colors.white,{align:'right'});
      text('AMOUNT (PHP)',x+tableW-4,tableY+6,8,true,colors.white,{align:'right'});
      entries.forEach((b,i)=>{
        const y=tableY+tableHeadH+i*rowH;
        if(i%2===0){fill(colors.light);doc.rect(x,y,tableW,rowH,'F');}
        text(b.label,x+4,y+3.6,8.3,false,colors.ink);
        text(String(b.count),x+93,y+3.6,8.3,false,colors.ink,{align:'right'});
        text(reportExportMoney(b.amount),x+tableW-4,y+3.6,8.3,true,b.amount?colors.ink:colors.muted,{align:'right'});
      });
    });
    const bottomY=tableY+tableHeadH+half*rowH;
    if(bottomY<192){
      stroke(colors.line);doc.line(left,bottomY+4,right,bottomY+4);
      text('This report lists qualifying transactions from the selected Firebase sales category.',left,bottomY+10,8,false,colors.muted);
      text('Total: '+cash(r.total),right,bottomY+10,9,true,colors.ink,{align:'right'});
    }

    // Detail pages - real table, alternating rows, automatic page breaks.
    if(r.rows.length){
      const colW=[33,43,28,52,78,35]; // 269 mm available on A4 landscape
      const colX=[left];for(let i=0;i<colW.length-1;i++) colX.push(colX[i]+colW[i]);
      const labels=['DATE / TIME (PHT)',r.source==='charging'?'CHARGING CARD':'RELOADER / BOOTH',
        'CARD UID',r.source==='charging'?'PORT / DURATION':'CUSTOMER','TRANSACTION ID','AMOUNT (PHP)'];
      let y=0;
      function startDetailPage(){
        doc.addPage('a4','landscape');
        fill(colors.dark);doc.rect(0,0,pageW,29,'F');
        fill(colors.amber);doc.rect(0,0,2.5,29,'F');
        text('TAMBAYAN  /  TRANSACTION DETAILS',left,13,15,true,colors.white);
        text(category+'  |  '+r.branchName+'  |  '+r.bounds.startKey+' - '+r.bounds.endKey,left,21,9,false,[217,225,231]);
        text(r.rows.length+' RECORDS',right,16,10,true,colors.white,{align:'right'});
        y=34;
        fill(colors.dark2);doc.rect(left,y,right-left,9,'F');
        labels.forEach((label,i)=>text(label,i===5?colX[i]+colW[i]-2:colX[i]+2,y+5.8,7.7,true,colors.white,i===5?{align:'right'}:{}));
        y+=9;
      }
      startDetailPage();
      r.rows.forEach((tx,index)=>{
        const values=[reportPhtTime(tx.timestamp),tx.owner,tx.cardUid||'-',tx.detail||'-',String(tx.id||''),cash(tx.amount)];
        const cells=values.map((v,i)=>{
          doc.setFont('helvetica','normal');doc.setFontSize(8.2);
          const lines=doc.splitTextToSize(String(v),colW[i]-4);
          return lines.length>3?lines.slice(0,2).concat([String(lines[2]).slice(0,34)+'...']):lines;
        });
        const maxLines=Math.max(...cells.map(c=>c.length));
        const rowHeight=Math.max(8.4,4.05*maxLines+3.5);
        if(y+rowHeight>194)startDetailPage();
        if(index%2===0){fill(colors.light);doc.rect(left,y,right-left,rowHeight,'F');}
        cells.forEach((lines,i)=>{
          lines.forEach((line,k)=>{
            const align=i===5?{align:'right'}:{};
            text(line,i===5?colX[i]+colW[i]-2:colX[i]+2,y+5+k*4.05,8.2,i===5,colors.ink,align);
          });
        });
        stroke(colors.line);doc.line(left,y+rowHeight,right,y+rowHeight);
        y+=rowHeight;
      });
    }
    const totalPages=doc.getNumberOfPages();
    for(let pg=1;pg<=totalPages;pg++){
      doc.setPage(pg);
      stroke(colors.line);doc.line(left,198,right,198);
      text('TAMBAYAN  •  '+category+'  •  '+r.period.toUpperCase(),left,204,7.8,false,colors.muted);
      text('Generated '+genAt+'  |  Page '+pg+' of '+totalPages,right,204,7.8,false,colors.muted,{align:'right'});
    }
    doc.save(reportFilename('pdf'));
  }
  // Start at today's Philippine date, with the relevant Month/Year selectors
  // visible based on the selected reporting period.
  document.getElementById('reportDate').value=reportPhtDay(Date.now());
  reportInitCalendarControls();
  // One registration form handles either a new physical branch + its first
  // reloader or an additional reloader for an existing physical location.
  // ================================================================
  // TAMBAYAN MODERN OVERVIEW — display-only, existing Firebase flows
  // are intentionally preserved. All totals come from reportCollect.
  // ================================================================
  let ovPendingCache = {};
  let ovPendingLoaded = false;
  const OV_PHP = new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',minimumFractionDigits:2,maximumFractionDigits:2});
  const OV_DATE = new Intl.DateTimeFormat('en-PH',{timeZone:'Asia/Manila',month:'short',day:'numeric',year:'numeric'});
  const OV_PHT = 8*60*60*1000;
  const OV_PAGES = {
    overview:['Overview','Hello, Ka-Tambay!','Your charging network, branches and daily performance—all in one place.'],
    lookup:['Card Lookup','Card Lookup','Search RFID cards, check balances and review recent transactions.'],
    reloads:['Pending Reloads','Pending Reloads','Review and approve incoming GCash requests.'],
    users:['Manage Users','Manage Users','Register RFID cards and manage global customer accounts.'],
    reloaders:['Branch & Reloader Management','Branch & Reloader Management','Manage physical locations, operator accounts and wallet float.'],
    reports:['Sales Reports','Sales Reports','Explore charging revenue and reloader collections separately.'],
    station:['Station Monitoring','Station Monitoring','Live battery status and station health monitoring.']
  };
  function toggleMobileNav(shouldOpen){
    const sidebar=document.getElementById('appSidebar');
    const backdrop=document.getElementById('sidebarBackdrop');
    const open=typeof shouldOpen==='boolean'?shouldOpen:!sidebar.classList.contains('mobile-open');
    sidebar.classList.toggle('mobile-open',open);
    backdrop.classList.toggle('is-open',open);
  }
  function setDashboardPage(name){
    const info=OV_PAGES[name]||OV_PAGES.overview;
    document.getElementById('headerCurrent').textContent=info[0];
    document.getElementById('pageHeading').textContent=info[1];
    document.getElementById('pageSubtitle').textContent=info[2];
    document.getElementById('dashDatePill').textContent=OV_DATE.format(new Date())+' · PHT';
  }
  function ovText(id,value){const el=document.getElementById(id);if(el)el.textContent=value;}
  function ovRound(n){return Math.round((Number(n)||0)*100)/100;}
  function ovSmallMoney(n){return OV_PHP.format(n);}
  function ovDayKeys(){
    const now=Date.now();
    const day=reportPhtDay(now);
    const lastDay=Date.parse(day+'T00:00:00Z');
    return Array.from({length:7},(_,i)=>new Date(lastDay-(6-i)*86400000).toISOString().slice(0,10));
  }
  function ovNode(tag,attributes,text){
    const node=document.createElementNS('http://www.w3.org/2000/svg',tag);
    if(attributes)Object.entries(attributes).forEach(([key,value])=>node.setAttribute(key,String(value)));
    if(text!==undefined)node.textContent=text;
    return node;
  }
  function ovDrawChart(keys,charges,topups){
    const svg=document.getElementById('overviewTrendChart');
    svg.replaceChildren();
    const plot={x:43,y:12,w:620,h:182};
    const max=Math.max(1,...charges,...topups);
    const ceiling=max===1?1:Math.ceil(max/10)*10;
    const y=value=>plot.y+plot.h-(value/ceiling)*plot.h;
    const x=i=>plot.x+plot.w*i/6;
    for(let i=0;i<=4;i++){
      const value=ceiling*i/4;
      const lineY=y(value);
      svg.appendChild(ovNode('line',{x1:plot.x,y1:lineY,x2:plot.x+plot.w,y2:lineY,stroke:'#e7eee7','stroke-width':1,'stroke-dasharray':i?'4 6':''}));
      svg.appendChild(ovNode('text',{x:plot.x-9,y:lineY+3,'text-anchor':'end','font-family':'Inter, sans-serif','font-size':10,fill:'#99ab9d'},value>=1000?(value/1000).toFixed(1)+'k':Math.round(value)));
    }
    const draw=(series,color)=>{
      const path=series.map((v,i)=>(i?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1)).join(' ');
      svg.appendChild(ovNode('path',{d:path,fill:'none',stroke:color,'stroke-width':3.1,'stroke-linecap':'round','stroke-linejoin':'round'}));
      series.forEach((v,i)=>{
        const c=ovNode('circle',{cx:x(i),cy:y(v),r:4.6,fill:'#fff',stroke:color,'stroke-width':2.5});
        c.appendChild(ovNode('title',null,`${keys[i]}: ${OV_PHP.format(v)}`));
        svg.appendChild(c);
      });
    };
    draw(charges,'#55b894');draw(topups,'#b2c958');
    const labels=document.getElementById('ovTrendLabels');labels.replaceChildren();
    keys.forEach(k=>{let d=document.createElement('div'); d.textContent=k.slice(5);labels.appendChild(d);});
  }
  function ovRenderStation(){
    const statusEl=document.getElementById('ovStationStatus');
    const dot=document.getElementById('sideSystemDot');
    const b=battLast;
    let state='is-unknown';let label='No readings';let subtitle='No station telemetry yet';
    if(b){
      const ms=reportTimeMs(b.updatedAt);
      const age=Number.isFinite(ms)?Date.now()-ms:NaN;
      const live=b.online===false?false:Number.isFinite(age)?age>=0 && age<=BATT_STALE_MS:null;
      state=live===true?'is-online':live===false?'is-offline':'is-unknown';
      label=live===true?'Online':live===false?'Offline':'Unverified';
      subtitle=live===true?'Battery readings online':live===false?'Station data stale/offline':'Check station timestamp';
      const socRaw=Number(b.percent ?? b.soc ?? b.SOC ?? b.socPercent);
      const soc=Number.isFinite(socRaw)?Math.max(0,Math.min(100,socRaw)):null;
      const ring=document.getElementById('ovHealthRing');
      ring.style.background=`conic-gradient(#b6db74 ${soc??0}%,#eaf0e7 ${soc??0}%)`;
      ovText('ovSoc',soc===null?'—':Math.round(soc)+'%');
      const voltage=Number(b.voltage ?? b.packVoltage);
      ovText('ovVoltage',Number.isFinite(voltage)&&voltage>0?voltage.toFixed(2)+' V':'—');
      const wh=Number(b.energyWh);
      const remaining=Number(b.remainingAh ?? b.remainingCapacityAh);
      const computed=Number.isFinite(wh) && wh>0?wh:Number.isFinite(remaining) && remaining>0 && Number.isFinite(voltage) && voltage>0?remaining*voltage:null;
      ovText('ovEnergy',computed===null?'—':computed.toFixed(0)+' Wh');
      ovText('ovStationUpdated',Number.isFinite(ms)?reportPhtTime(ms).slice(11)+' PHT':'Unknown');
    } else {
      ovText('ovSoc','—');ovText('ovVoltage','—');ovText('ovEnergy','—');ovText('ovStationUpdated','—');
      document.getElementById('ovHealthRing').style.background='conic-gradient(#eaf0e7 100%,#eaf0e7 100%)';
    }
    statusEl.textContent=label;statusEl.className='station-status '+state;
    dot.className='system-dot'+(state==='is-online'?' online':state==='is-offline'?' offline':'');
    ovText('sideSystemText',subtitle);
  }
  function ovCreateCell(tr,value,cls){
    const td=document.createElement('td');td.textContent=String(value);if(cls)td.className=cls;tr.appendChild(td);return td;
  }
  function renderOverview(){
    if(!reportAdminVerified) return;
    setDashboardPageDate();
    const userLoaded=reportUsersLoaded;
    const reloaderLoaded=reportReloadersLoaded;
    const branchLoaded=branchesLoaded;
    const charging=userLoaded?reportCollect('charging').records:[];
    const topups=reloaderLoaded?reportCollect('reloader').records:[];
    const valid=(arr)=>arr.filter(r=>Number.isFinite(r.timestamp)&&Number.isFinite(r.amount)&&r.amount>0);
    const charges=valid(charging),reloads=valid(topups);
    const currentDay=reportPhtDay(Date.now());
    const today=(arr)=>arr.filter(r=>reportPhtDay(r.timestamp)===currentDay);
    const todayCharges=today(charges),todayReloads=today(reloads);
    ovText('ovCharging',userLoaded?ovSmallMoney(ovRound(todayCharges.reduce((s,r)=>s+r.amount,0))):'—');
    ovText('ovChargingNote',userLoaded?todayCharges.length+' completed charging session'+(todayCharges.length===1?'':'s'):'Loading charging history…');
    ovText('ovTopups',reloaderLoaded?ovSmallMoney(ovRound(todayReloads.reduce((s,r)=>s+r.amount,0))):'—');
    ovText('ovTopupsNote',reloaderLoaded?todayReloads.length+' authorized terminal top-up'+(todayReloads.length===1?'':'s'):'Loading reloader collections…');
    ovText('ovCards',userLoaded?Object.keys(allUsersCache).length.toLocaleString('en-PH'):'—');
    ovText('ovCardsNote','Across all physical branches');
    const activeBranches=Object.values(allBranchesCache).filter(b=>b && b.status==='active').length;
    ovText('ovBranches',branchLoaded?String(activeBranches):'—');
    ovText('ovBranchesNote',branchLoaded?Object.keys(allBranchesCache).length+' branches registered':'Loading branch list…');
    ovText('ovPending',ovPendingLoaded?Object.keys(ovPendingCache).length.toLocaleString('en-PH'):'—');
    const agents=Object.values(allReloadersCache);
    ovText('ovAgents',reloaderLoaded?String(agents.filter(a=>a&&(a.status||'active')==='active').length):'—');
    ovText('ovFloat',reloaderLoaded?OV_PHP.format(ovRound(agents.reduce((s,a)=>s+Math.max(0,Number(a.balance)||0),0))):'—');
    ovRenderStation();
    const keys=ovDayKeys();
    const accumulate=(records)=>keys.map(k=>ovRound(records.filter(r=>reportPhtDay(r.timestamp)===k).reduce((s,r)=>s+r.amount,0)));
    ovDrawChart(keys,accumulate(charges),accumulate(reloads));
    ovText('ovTrendNote',userLoaded&&reloaderLoaded?'Completed transactions only · data updates from Firebase':'Some data is still loading…');
    // Every branch row requires explicit event-origin branchUid, not current operator assignment.
    const branchRows=document.getElementById('ovBranchRows');branchRows.replaceChildren();
    if(!branchLoaded||!reloaderLoaded||!userLoaded){
      const tr=document.createElement('tr');ovCreateCell(tr,'Loading branch data…','overview-empty').colSpan=4;branchRows.appendChild(tr);
    } else {
      const listed=Object.entries(allBranchesCache).map(([id,b])=>({id,name:String(b?.name||id),count:agents.filter(a=>a&&a.branchUid===id).length,
        charged:todayCharges.filter(r=>r.branchUid===id).reduce((s,r)=>s+r.amount,0),topup:todayReloads.filter(r=>r.branchUid===id).reduce((s,r)=>s+r.amount,0)})).sort((a,b)=>(b.charged+b.topup)-(a.charged+a.topup)||a.name.localeCompare(b.name));
      if(!listed.length){const tr=document.createElement('tr');ovCreateCell(tr,'No branches registered','overview-empty').colSpan=4;branchRows.appendChild(tr);}
      listed.slice(0,5).forEach(b=>{const tr=document.createElement('tr');ovCreateCell(tr,b.name,'branch-name');ovCreateCell(tr,ovSmallMoney(b.topup),'amount-cell');ovCreateCell(tr,ovSmallMoney(b.charged),'amount-cell');ovCreateCell(tr,b.count);branchRows.appendChild(tr);});
      const unattributedToday=todayCharges.filter(r=>!r.branchUid).length+todayReloads.filter(r=>!r.branchUid).length;
      ovText('ovBranchWarning',unattributedToday?`${unattributedToday} transaction(s) today are missing branchUid. Per-branch totals are incomplete; see Sales Reports.`:'Branch totals include only explicitly tagged sales. Charging and top-ups are shown separately.');
    }
    const recents=document.getElementById('ovRecentRows');recents.replaceChildren();
    if(!userLoaded||!reloaderLoaded){const tr=document.createElement('tr');ovCreateCell(tr,'Loading recent activity…','overview-empty').colSpan=5;recents.appendChild(tr);}
    else {
      const list=[...charges.map(r=>({...r,kind:'charge'})),...reloads.map(r=>({...r,kind:'reload'}))].sort((a,b)=>b.timestamp-a.timestamp).slice(0,7);
      if(!list.length){const tr=document.createElement('tr');ovCreateCell(tr,'No completed transactions recorded yet','overview-empty').colSpan=5;recents.appendChild(tr);}
      list.forEach(r=>{const tr=document.createElement('tr');ovCreateCell(tr,reportPhtTime(r.timestamp));const typeCell=ovCreateCell(tr,'');const type=document.createElement('span');type.className='activity-type '+r.kind;type.textContent=r.kind==='charge'?'Charging':'Top-up';typeCell.appendChild(type);ovCreateCell(tr,r.branchUid?(allBranchesCache[r.branchUid]?.name||'Unlisted branch'):'Unassigned');ovCreateCell(tr,r.cardUid||r.owner||'—');ovCreateCell(tr,ovSmallMoney(r.amount),'amount-cell');recents.appendChild(tr);});
    }
  }
  function setDashboardPageDate(){
    const el=document.getElementById('dashDatePill');
    if(el)el.textContent=OV_DATE.format(new Date())+' · PHT';
  }
