# 다비도 밴픽쇼 전송용 파일

이 폴더는 다른 컴퓨터에서 밴픽쇼 서버를 실행하기 위한 최소 파일 묶음입니다.

## 포함 파일

- `server.js` - 밴픽쇼 서버, WebSocket, LCU 데이터 수신 API
- `lcu-relay.js` - 롤이 켜진 컴퓨터에서 LCU 정보를 서버로 보내는 릴레이
- `package.json` - 필요한 Node 패키지 목록
- `public/draft-show.html` - OBS/브라우저에서 보는 밴픽쇼 화면

## 서버 컴퓨터에서 실행

```powershell
npm install
$env:PORT="3004"; node server.js
```

다른 컴퓨터에서 접속:

```txt
http://서버컴퓨터IP:3004/draft-show.html
```

서버 컴퓨터 IP 확인:

```powershell
ipconfig
```

`IPv4 주소` 값을 사용하면 됩니다.

## 롤이 켜진 컴퓨터에서 자동 연동 실행

롤이 서버 컴퓨터와 같은 컴퓨터에서 켜져 있으면 추가 실행이 필요 없습니다.

롤이 다른 컴퓨터에서 켜져 있으면, 롤이 켜진 컴퓨터에서 아래 명령을 실행합니다.

```powershell
node lcu-relay.js http://서버컴퓨터IP:3004
```

Railway 서버로 보내려면:

```powershell
node lcu-relay.js https://davido-inhouse-production.up.railway.app
```

## OBS에 넣는 주소

로컬/LAN 서버:

```txt
http://서버컴퓨터IP:3004/draft-show.html
```

Railway:

```txt
https://davido-inhouse-production.up.railway.app/draft-show.html
```

## 주의

- `localhost`는 그 컴퓨터 자기 자신입니다. 다른 컴퓨터에서는 서버 컴퓨터의 IP 주소를 써야 합니다.
- 자동 밴픽 감지는 롤이 켜진 컴퓨터에서만 가능합니다.
- 롤이 서버 컴퓨터가 아닌 다른 컴퓨터에 켜져 있으면 `lcu-relay.js`를 반드시 실행해야 합니다.
