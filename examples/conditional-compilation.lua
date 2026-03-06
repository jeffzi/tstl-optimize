playerHp = hp
initDesktopRenderer()
setupDesktop()
speed = baseSpeed
label = "Desktop"
safeHp = hp
x = hp + 1
offline = true
ok = true
setupDesktop()
if isAlive then
    print("alive")
end
if true and connected then
    print("desktop + connected")
end
repeat
    local ____switch4 = mode
    local ____cond4 = ____switch4 == 1
    if ____cond4 then
        print("one")
        break
    end
    do
        print("other")
        break
    end
until true
isDebug = false
isWeb = false
print(playerHp)
print(speed)
print(label)
print(isDebug)
print(isWeb)
