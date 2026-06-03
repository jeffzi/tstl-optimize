local ____exports = {}
local function numberLiteral()
    return 42
end
local function negativeLiteral()
    local x = -5
    return (-5)
end
local function stringLiteral()
    return "hello"
end
local function booleanLiteral()
    return true
end
local function multipleReads()
    consume(10)
    return 10
end
local MODULE_CONST = 42
____exports.EXPORTED = 42
local function chainedWithFolding()
    return 16777216
end
local function reassigned()
    local x
    x = 2
    return x
end
local function closureCapture()
    local x = 10
    return function() return x end
end
local function nonLiteral()
    local x = compute()
    return x
end
print(numberLiteral())
print(negativeLiteral())
print(stringLiteral())
print(booleanLiteral())
print(multipleReads())
print(____exports.EXPORTED)
print(chainedWithFolding())
print(reassigned())
print(closureCapture()())
print(nonLiteral())
return ____exports
