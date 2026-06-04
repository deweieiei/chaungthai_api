#!/bin/bash
# ============================================================
#  Test full flow: register user -> login -> become worker (resume + skills) -> verify
# ============================================================

set -u
BASE="http://localhost:3000"
CT="Content-Type: application/json"
hr() { echo; echo "=== $1 ==="; }

EMAIL="builder$(date +%s)@chaungthai.com"
PASS="builderpass1234"

hr "1. Register user: $EMAIL"
curl -s -X POST "$BASE/api/auth/register" -H "$CT" \
  -d "{\"user_name\":\"ช่างใหม่\",\"user_lastname\":\"ทดสอบ\",\"user_email\":\"$EMAIL\",\"user_password\":\"$PASS\"}" \
  | python3 -m json.tool

hr "2. Login -> token"
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL\",\"user_password\":\"$PASS\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
USER_ID=$(echo "$LOGIN" | python3 -c 'import sys,json; print(json.load(sys.stdin)["user"]["user_id"])')
echo "user_id: $USER_ID  token: ${TOKEN:0:30}..."

hr "3. Check user_role BEFORE -> should be 'user'"
curl -s "$BASE/api/users/$USER_ID" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("user_role:", d["user"]["user_role"])'

hr "4. POST /api/workers (resume + skill_ids [11,13,118])"
WORKER_RES=$(curl -s -X POST "$BASE/api/workers" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"worker_resume":"ช่างไฟฟ้า + ช่างคอม 5 ปี","skill_ids":[11,13,118]}')
echo "$WORKER_RES" | python3 -m json.tool
WORKER_ID=$(echo "$WORKER_RES" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("worker_id",""))')

hr "5. Check user_role AFTER -> should be 'worker'"
curl -s "$BASE/api/users/$USER_ID" | python3 -c 'import sys,json; d=json.load(sys.stdin); print("user_role:", d["user"]["user_role"])'

hr "6. Verify DB - worker_chaungthai (tickets=25?)"
export MYSQL_PWD='Dew@1234'
mysql -uroot chaungthai -e "SELECT worker_id, worker_user_id, worker_job_tickets, worker_total_jobs, LEFT(worker_resume,40) AS resume FROM worker_chaungthai WHERE worker_id=$WORKER_ID;"

hr "7. Verify DB - workerskill_chaungthai (3 rows?)"
mysql -uroot chaungthai -e "SELECT ws.workerskill_id, ws.workerskill_worker_id, ws.workerskill_skill_id, sk.skill_name_th FROM workerskill_chaungthai ws JOIN skill_chaungthai sk ON sk.skill_id = ws.workerskill_skill_id WHERE workerskill_worker_id=$WORKER_ID;"

hr "8. POST /api/workers again -> should 409 duplicate"
curl -s -X POST "$BASE/api/workers" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d '{"worker_resume":"again","skill_ids":[1]}'

hr "9. Edge: register without skills (just resume)"
EMAIL2="builder2_$(date +%s)@chaungthai.com"
curl -s -X POST "$BASE/api/auth/register" -H "$CT" \
  -d "{\"user_name\":\"x\",\"user_email\":\"$EMAIL2\",\"user_password\":\"xpass1234\"}" > /dev/null
TOKEN2=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL2\",\"user_password\":\"xpass1234\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
curl -s -X POST "$BASE/api/workers" -H "$CT" -H "Authorization: Bearer $TOKEN2" \
  -d '{}' | python3 -m json.tool

hr "10. Edge: bad skill_id -> 400"
EMAIL3="builder3_$(date +%s)@chaungthai.com"
curl -s -X POST "$BASE/api/auth/register" -H "$CT" \
  -d "{\"user_name\":\"y\",\"user_email\":\"$EMAIL3\",\"user_password\":\"ypass1234\"}" > /dev/null
TOKEN3=$(curl -s -X POST "$BASE/api/auth/login" -H "$CT" \
  -d "{\"user_email\":\"$EMAIL3\",\"user_password\":\"ypass1234\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
curl -s -X POST "$BASE/api/workers" -H "$CT" -H "Authorization: Bearer $TOKEN3" \
  -d '{"skill_ids":[1,99999]}'

hr "DONE"
