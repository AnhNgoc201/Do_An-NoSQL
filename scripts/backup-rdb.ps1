param([string]$Container='redis-orders',[string]$OutputDirectory=(Join-Path $PSScriptRoot '..\backups'))
$ErrorActionPreference='Stop'
function Redis-Raw([string[]]$Arguments){
    $result = & docker exec $Container redis-cli --raw @Arguments
    if($LASTEXITCODE -ne 0){throw 'Không đọc được Redis trong container.'}
    return $result
}
$info=Redis-Raw @('INFO','server')
if(-not ($info -match '^redis_version:')){throw 'Không kết nối được Redis. Công cụ này dùng Redis local không yêu cầu AUTH.'}
$image=(& docker inspect --format '{{.Config.Image}}' $Container).Trim()
if($LASTEXITCODE -ne 0){throw 'Không xác định được image nguồn.'}
$dir=@(Redis-Raw @('CONFIG','GET','dir'))[-1].Trim()
$filename=@(Redis-Raw @('CONFIG','GET','dbfilename'))[-1].Trim()
if(-not $dir.StartsWith('/') -or $filename.Contains('/') -or $filename.Contains('\')){throw 'Đường dẫn RDB không hợp lệ.'}
$reply=Redis-Raw @('BGSAVE')
if(($reply -join '') -notmatch 'Background saving started'){throw ('Không khởi tạo được BGSAVE: '+$reply)}
$saved=$false
for($i=0;$i -lt 120;$i++){
    Start-Sleep -Milliseconds 250
    $persistence=Redis-Raw @('INFO','persistence')
    if($persistence -match '^rdb_bgsave_in_progress:0'){
        if(-not ($persistence -match '^rdb_last_bgsave_status:ok')){throw 'BGSAVE kết thúc với lỗi.'}
        $saved=$true;break
    }
}
if(-not $saved){throw 'Chưa hoàn tất BGSAVE sau 30 giây; không sao chép file đang ghi.'}
$folder=Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) ('rdb-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $folder | Out-Null
$source=$dir.TrimEnd('/')+'/'+$filename
& docker cp "${Container}:$source" (Join-Path $folder 'dump.rdb')
if($LASTEXITCODE -ne 0){throw 'Không sao chép được RDB.'}
$hash=(Get-FileHash -LiteralPath (Join-Path $folder 'dump.rdb') -Algorithm SHA256).Hash
@{createdAt=(Get-Date).ToUniversalTime().ToString('o');sourceContainer=$Container;image=$image;sha256=$hash;scope='ALL databases, includes auth data. Keep private.'} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder 'manifest.json') -Encoding UTF8
Write-Output "Backup hoàn tất: $folder"
Write-Output 'RDB chứa toàn bộ database và thông tin đăng nhập. Không chia sẻ công khai.'
