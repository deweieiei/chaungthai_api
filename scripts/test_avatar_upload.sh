#!/bin/bash
# ============================================================
#  Test avatar upload flow
# ============================================================
set -u
BASE="http://localhost:3000"
hr() { echo; echo "=== $1 ==="; }

hr "1. login user_id=4 -> token"
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"user_email":"test1@example.com","user_password":"testpass1234"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
echo "token: ${TOKEN:0:40}..."

hr "2. create test PNG (1x1 transparent)"
# 67-byte PNG 1x1
printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xfc\xff\xff?\x03\x00\x06\x05\x02\xff\x9a\xd8\x6b\xa3\x00\x00\x00\x00IEND\xaeB`\x82' > /tmp/test_avatar.png
ls -la /tmp/test_avatar.png && file /tmp/test_avatar.png

hr "3. POST /api/users/4/image (success)"
curl -s -X POST "$BASE/api/users/4/image" \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@/tmp/test_avatar.png" | python3 -m json.tool

hr "4. verify DB"
export MYSQL_PWD='Dew@1234'
mysql -uroot chaungthai -e "SELECT user_id, user_image FROM user_chaungthai WHERE user_id=4;"

hr "5. ls uploads/avatars"
ls -la ~/projcet/chaungthai_api/uploads/avatars/ | head -10

hr "6. fetch the uploaded URL"
URL=$(mysql -uroot chaungthai -se "SELECT user_image FROM user_chaungthai WHERE user_id=4;")
echo "URL: $URL"
curl -s -o /dev/null -w "HTTP %{http_code}  bytes=%{size_download}  type=%{content_type}\n" "$BASE$URL"

hr "7. upload again (test ลบรูปเก่า)"
curl -s -X POST "$BASE/api/users/4/image" \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@/tmp/test_avatar.png" | python3 -m json.tool

hr "8. ls again (รูปเก่าควรถูกลบ)"
ls -la ~/projcet/chaungthai_api/uploads/avatars/ | head -10

hr "9. test bad MIME (text file) -> should 400"
echo "not an image" > /tmp/notimg.txt
curl -s -X POST "$BASE/api/users/4/image" \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@/tmp/notimg.txt;type=text/plain"
echo

hr "10. test no token -> should 401"
curl -s -X POST "$BASE/api/users/4/image" -F "image=@/tmp/test_avatar.png"
echo

hr "11. test wrong owner (user_id=5) -> should 403"
curl -s -X POST "$BASE/api/users/5/image" \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@/tmp/test_avatar.png"
echo

hr "12. cleanup"
rm -f /tmp/test_avatar.png /tmp/notimg.txt
echo "DONE"
