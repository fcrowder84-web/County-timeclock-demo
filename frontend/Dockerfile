FROM nginx:alpine

COPY default.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/index.html
COPY sso.html /usr/share/nginx/html/sso.html
COPY safe-html.js /usr/share/nginx/html/safe-html.js
COPY employee.html /usr/share/nginx/html/employee.html
COPY supervisor.html /usr/share/nginx/html/supervisor.html
COPY department-structure.html /usr/share/nginx/html/department-structure.html
COPY payroll.html /usr/share/nginx/html/payroll.html
COPY payroll-timecards.html /usr/share/nginx/html/payroll-timecards.html
COPY leave.html /usr/share/nginx/html/leave.html
COPY timecard-summary-ui.js /usr/share/nginx/html/timecard-summary-ui.js
COPY timecard.html /usr/share/nginx/html/timecard.html
COPY timecard.css /usr/share/nginx/html/timecard.css
COPY timecard-base.js /usr/share/nginx/html/timecard-base.js
COPY timecard-actions.js /usr/share/nginx/html/timecard-actions.js
COPY timecard-single-punch.js /usr/share/nginx/html/timecard-single-punch.js
COPY mobile-pairing.js /usr/share/nginx/html/mobile-pairing.js
COPY mobile.html /usr/share/nginx/html/mobile.html
COPY punches.html /usr/share/nginx/html/punches.html
COPY manifest.webmanifest /usr/share/nginx/html/manifest.webmanifest
COPY mobile-sw.js /usr/share/nginx/html/mobile-sw.js
COPY timeclock-icon.svg /usr/share/nginx/html/timeclock-icon.svg

COPY global-logout.html /usr/share/nginx/html/global-logout.html
