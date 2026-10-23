import esphome.codegen as cg
from esphome.components import text_sensor
import esphome.config_validation as cv
from esphome.const import CONF_QOS, CONF_TOPIC

from . import panel_mqtt_ns

DEPENDENCIES = ["mqtt"]

DynamicMqttTextSensor = panel_mqtt_ns.class_("DynamicMqttTextSensor", text_sensor.TextSensor, cg.Component)

CONFIG_SCHEMA = (
    text_sensor.text_sensor_schema(DynamicMqttTextSensor)
    .extend(
        {
            cv.Required(CONF_TOPIC): cv.string,
            cv.Optional(CONF_QOS, default=0): cv.mqtt_qos,
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config):
    var = await text_sensor.new_text_sensor(config)
    await cg.register_component(var, config)
    cg.add(var.set_topic_suffix(config[CONF_TOPIC]))
    cg.add(var.set_qos(config[CONF_QOS]))
