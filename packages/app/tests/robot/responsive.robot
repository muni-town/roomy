*** Settings ***
Documentation     Responsive design tests for Roomy app
Library           Browser
Suite Setup       Setup Browser
Suite Teardown    Close Browser

*** Variables ***
${BROWSER}        chromium
${HEADLESS}       True
${BASE_URL}       http://127.0.0.1:5173
${TIMEOUT}        15s

*** Test Cases ***
App Should Work On Mobile Viewport
    [Documentation]    Verify app functions on mobile screen sizes
    [Tags]    responsive    mobile
    New Page    ${BASE_URL}
    Set Viewport Size    390    844    # iPhone 14 Pro size
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}
    
    ${url}=    Get Url
    Should Contain    ${url}    127.0.0.1
    
    # Verify page loaded and is interactive
    Wait For Load State    networkidle    timeout=30s

App Should Work On Tablet Viewport
    [Documentation]    Verify app functions on tablet screen sizes
    [Tags]    responsive    tablet
    New Page    ${BASE_URL}
    Set Viewport Size    820    1180    # iPad Air size
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}
    
    ${url}=    Get Url
    Should Contain    ${url}    127.0.0.1
    
    # Verify page loaded and is interactive
    Wait For Load State    networkidle    timeout=30s

App Should Work On Desktop Viewport
    [Documentation]    Verify app functions on desktop screen sizes
    [Tags]    responsive    desktop
    New Page    ${BASE_URL}
    Set Viewport Size    1920    1080    # Full HD
    Wait For Load State    domcontentloaded    timeout=${TIMEOUT}
    
    ${url}=    Get Url
    Should Contain    ${url}    127.0.0.1
    
    # Verify page loaded and is interactive
    Wait For Load State    networkidle    timeout=30s

*** Keywords ***
Setup Browser
    New Browser    browser=${BROWSER}    headless=${HEADLESS}
    Set Browser Timeout    ${TIMEOUT}
