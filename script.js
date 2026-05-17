const display = document.getElementById('result');

function appendToDisplay(value) {
    display.value += value;
}

function clearScreen() {
    display.value = '';
}

function calculate() {
    try {
        display.value = eval(display.value);
    } catch (error) {
        display.value = 'Error';
    }
}
