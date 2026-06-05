#!/bin/bash
# ============================================================
#  Test MVP completeness endpoints
# ============================================================
set -u
BASE="http://localhost:3000"
CT="Content-Type: application/json"
hr() { echo; echo "=== $1 ==="; }

EMAIL="mvp_$(date +%s)@chaungthai.com"
PASS="mvppass1234"
NEW_PASS="newpass1234"

hr "1. register"
curl -s -X POST "$BASE/api/auth/register" -H "$CT" \
  -d "{\"user_name\":\"MVP\",\"user_email\":\"$EMAIL\",\"user_password\":\"$PASS\"}" | python3 -m json.tool

hr "2. login -> token + user_id"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\",\"user_password\":\"$PASS\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
USER_ID=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["user"]["user_id"])')
echo "user_id=$USER_ID  token=${TOKEN:0:30}..."

hr "3. verify-email/request -> verify_url"
EMAIL_RES=$(curl -s -X POST "$BASE/api/auth/verify-email/request" \
  -H "Authorization: Bearer $TOKEN")
echo "$EMAIL_RES" | python3 -m json.tool
ETOK=$(echo "$EMAIL_RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["verify_token"])')

hr "4. verify-email/confirm"
curl -s -X POST "$BASE/api/auth/verify-email/confirm" -H "$CT" \
  -d "{\"token\":\"$ETOK\"}" | python3 -m json.tool

hr "5. set phone (PUT user)"
curl -s -X PUT "$BASE/api/users/$USER_ID" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"user_phone":"0812345678"}' > /dev/null && echo "phone set"

hr "6. verify-phone/request -> OTP"
PHONE_RES=$(curl -s -X POST "$BASE/api/auth/verify-phone/request" \
  -H "Authorization: Bearer $TOKEN")
echo "$PHONE_RES" | python3 -m json.tool
OTP=$(echo "$PHONE_RES" | python3 -c 'import sys,json; print(json.load(sys.stdin)["otp_code"])')

hr "7. verify-phone request again -> 429 (rate limit)"
curl -s -X POST "$BASE/api/auth/verify-phone/request" -H "Authorization: Bearer $TOKEN"
echo

hr "8. verify-phone/confirm (OTP=$OTP)"
curl -s -X POST "$BASE/api/auth/verify-phone/confirm" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"otp_code\":\"$OTP\"}" | python3 -m json.tool

hr "9. verify-phone/confirm bad OTP -> 400"
curl -s -X POST "$BASE/api/auth/verify-phone/confirm" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"otp_code":"000000"}'
echo

hr "10. PATCH password (old=PASS new=NEW_PASS)"
curl -s -X PATCH "$BASE/api/users/$USER_ID/password" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"old_password\":\"$PASS\",\"new_password\":\"$NEW_PASS\"}" | python3 -m json.tool

hr "11. PATCH password wrong old -> 401"
curl -s -X PATCH "$BASE/api/users/$USER_ID/password" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"old_password":"wrongold","new_password":"anyothernewpass"}'
echo

hr "12. login with NEW password"
curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\",\"user_password\":\"$NEW_PASS\"}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("login OK, user:", d["user"]["user_name"])'

hr "13. forgot-password (existing)"
F1=$(curl -s -X POST "$BASE/api/auth/forgot-password" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\"}")
echo "$F1" | python3 -m json.tool
RTOK=$(echo "$F1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["reset_token"])')

hr "14. forgot-password (non-existing -> same message, no token)"
curl -s -X POST "$BASE/api/auth/forgot-password" -H "$CT" \
  -d '{"user_email":"nobody@nope.com"}' | python3 -m json.tool

hr "15. reset-password"
RESETPASS="resetpass1234"
curl -s -X POST "$BASE/api/auth/reset-password" -H "$CT" \
  -d "{\"token\":\"$RTOK\",\"new_password\":\"$RESETPASS\"}" | python3 -m json.tool

hr "16. login with reset password"
curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\",\"user_password\":\"$RESETPASS\"}" \
  | python3 -c 'import sys,json; print("login OK") if "token" in json.load(sys.stdin) else print("fail")'

hr "17. Re-login fresh token"
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\",\"user_password\":\"$RESETPASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

hr "18. GET /workers/4 (existing worker - detail)"
curl -s "$BASE/api/workers/4" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("worker_id:", d["worker"]["worker_id"])
print("name:", d["user"]["user_name"], d["user"].get("user_lastname",""))
print("tickets:", d["worker"]["worker_job_tickets"])
print("location:", d["location"]["province_name_th"] or "-")
print("skills count:", len(d["skills"]))
print("portfolio count:", len(d["portfolio_images"]))
print("skills sample:", [s["skill_name_th"] for s in d["skills"][:3]])
'

hr "19. GET /workers/99999 -> 404"
curl -s "$BASE/api/workers/99999"
echo

hr "20. DELETE user (close account, password=RESETPASS)"
curl -s -X DELETE "$BASE/api/users/$USER_ID" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"password\":\"$RESETPASS\"}" | python3 -m json.tool

hr "21. DB verify user_status = Closed"
export MYSQL_PWD='Dew@1234'
mysql -uroot chaungthai -e "SELECT user_id, user_email, user_status FROM user_chaungthai WHERE user_id=$USER_ID;"

hr "22. Try login after close -> 403"
curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\",\"user_password\":\"$RESETPASS\"}"
echo

hr "23. DELETE again -> 401 (no longer Active)"
curl -s -X DELETE "$BASE/api/users/$USER_ID" -H "$CT" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"password\":\"$RESETPASS\"}"
echo

hr "24. Search workers - check Closed not showing"
# กระบวนการ: ปิดบัญชี user_id=6 (existing worker), search, ดูว่าไม่ขึ้น
mysql -uroot chaungthai -e "UPDATE user_chaungthai SET user_status='Closed' WHERE user_id=6;"
echo "set user_id=6 to Closed"
curl -s "$BASE/api/workers/search?skill_id=13&province_id=1" | python3 -c '
import sys, json
d = json.load(sys.stdin)
print("total found:", d["total"])
for w in d["workers"]:
    print("  - worker_id=" + str(w["worker_id"]) + " user_id=" + str(w["user_id"]))
'
# กู้คืนสำหรับครั้งหน้า
mysql -uroot chaungthai -e "UPDATE user_chaungthai SET user_status='Active' WHERE user_id=6;"
echo "restored user_id=6 to Active"

hr "DONE"
