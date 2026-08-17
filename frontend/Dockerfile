FROM nginx:alpine

COPY default.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/index.html
COPY sso.html /usr/share/nginx/html/sso.html
COPY employee.html /usr/share/nginx/html/employee.html
COPY supervisor.html /usr/share/nginx/html/supervisor.html
COPY payroll.html /usr/share/nginx/html/payroll.html
COPY payroll-timecards.html /usr/share/nginx/html/payroll-timecards.html
COPY leave.html /usr/share/nginx/html/leave.html
COPY timecard-summary-ui.js /usr/share/nginx/html/timecard-summary-ui.js

COPY global-logout.html /usr/share/nginx/html/global-logout.html
