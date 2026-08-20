FROM nginx:alpine

COPY default.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/index.html
COPY sso.html /usr/share/nginx/html/sso.html
COPY safe-html.js /usr/share/nginx/html/safe-html.js
COPY employee.html /usr/share/nginx/html/employee.html
COPY supervisor.html /usr/share/nginx/html/supervisor.html
COPY payroll.html /usr/share/nginx/html/payroll.html
COPY payroll-timecards.html /usr/share/nginx/html/payroll-timecards.html
COPY leave.html /usr/share/nginx/html/leave.html
COPY timecard-summary-ui.js /usr/share/nginx/html/timecard-summary-ui.js
COPY mobile.html /usr/share/nginx/html/mobile.html
COPY punches.html /usr/share/nginx/html/punches.html
COPY manifest.webmanifest /usr/share/nginx/html/manifest.webmanifest
COPY mobile-sw.js /usr/share/nginx/html/mobile-sw.js
COPY timeclock-icon.svg /usr/share/nginx/html/timeclock-icon.svg

COPY global-logout.html /usr/share/nginx/html/global-logout.html
