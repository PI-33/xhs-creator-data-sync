const Utils = {
  parseBitableUrl(url) {
    const match = url.match(/\/base\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
  },

  formatDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d.getTime();
  },

  today() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  },

  log(msg) {
    console.log(`[XHS-Sync] ${msg}`);
  }
};

if (typeof window !== 'undefined') {
  window.XHSUtils = Utils;
}
